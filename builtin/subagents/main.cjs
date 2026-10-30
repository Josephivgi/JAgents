// Subagents (built into JAgents): agents that belong to one parent agent.
//
// A parent (any agent JAgents started) calls the "subagents" MCP server to
// start Claude Code, Codex, Factory Droid, Devin, Cursor, Gemini, OpenCode or
// any installed ACP agent on a task. The subagent runs headless inside
// JAgents: it gets no pane, no thread, and is not in the JAgents agent network
// (list_agents, send_message and read_agent do not see it). Only its parent
// can message, read, wait on or stop it; anyone else goes through the parent.
//
// Subagents get a fixed set of MCP servers (built-in and plugin servers the
// user allows on the Subagents page), never jagents or subagents, so a subagent cannot start
// agents of its own. Its process also points JAGENTS_HUB_FILE at nothing, so
// a jagents server installed in an agent's own global config cannot reach the
// hub either.
//
// Records and transcripts are kept in SQLite (plugin-data/subagents/
// subagents.db). Sessions do not survive an app restart; a
// message to a stopped subagent starts a new session with a recap.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const WAIT_DEFAULT_S = 50;
const WAIT_MAX_S = 900;
const MAX_LIVE_PER_PARENT = 6;
const ROWS_MAX = 400;
const TEXT_MAX = 20000;

const ALIASES = { droid: "factory-droid", factory: "factory-droid", claude: "claude-code", "codex-acp": "codex", "gemini-cli": "gemini", pi: "pi-acp" };
// Never handed to subagents.
const BLOCKED_SERVERS = new Set(["jagents", "relay", "subagents"]);
// Claude Code built-ins that start, schedule or message agents.
const CLAUDE_BLOCKED_TOOLS = ["Agent", "Task", "SendMessage", "ListAgents", "TaskStop", "RemoteTrigger", "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "TeamCreate", "TeamDelete", "mcp__jagents", "mcp__relay", "mcp__subagents"];

const clampWait = (s) => Math.min(WAIT_MAX_S, Math.max(1, Number(s) > 0 ? Number(s) : WAIT_DEFAULT_S)) * 1000;
const errText = (e) => String((e && e.message) || e);

// JAgents' own agent launch code, so subagents start exactly as its chats do.
// The app has already loaded it; take the same module instances from the
// cache (wherever this JAgents runs from), so marketplace agents are known too.
function appLibDir() {
  const hit = Object.keys(require.cache).find((k) => /[\\/]lib[\\/]acp-client\.js$/.test(k));
  if (!hit) throw new Error("Could not find JAgents' lib folder.");
  return path.dirname(hit);
}
function appLib(name) {
  return require(path.join(appLibDir(), name));
}

exports.activate = (ctx) => {
  const agentsLib = appLib("agents.js");
  const { AcpClient } = appLib("acp-client.js");
  const { ClaudeSdkClient } = appLib("claude-sdk-client.js");

  // Claude Code subagents get only the MCP servers passed in (not the user's
  // own ~/.claude.json servers): --strict-mcp-config on its command line.
  class SubagentClaude extends ClaudeSdkClient {
    _spawn(opts) {
      const args = (opts.args || []).includes("--strict-mcp-config") ? opts.args : [...(opts.args || []), "--strict-mcp-config"];
      return super._spawn(Object.assign({}, opts, { args }));
    }
  }

  // The hub of the JAgents this runs in (inside JWorkspace it need not be
  // ~/.jagents); apps from before ctx.hubDir fall back to the old lookup.
  const HOME_DIR = ctx.hubDir || (process.env.JAGENTS_HOME ? path.resolve(process.env.JAGENTS_HOME) : path.join(os.homedir(), ".jagents"));
  const DEAD_HUB = path.join(ctx.dataDir, "no-hub-for-subagents.json");

  // ---- Storage ----
  const db = new DatabaseSync(path.join(ctx.dataDir, "subagents.db"));
  db.exec(
    "CREATE TABLE IF NOT EXISTS subagents (handle TEXT PRIMARY KEY, parent TEXT NOT NULL, provider TEXT NOT NULL, provider_name TEXT, task TEXT, cwd TEXT, status TEXT, error TEXT, created_at INTEGER, updated_at INTEGER, transcript TEXT);" +
      "CREATE INDEX IF NOT EXISTS subagents_parent ON subagents(parent);" +
      "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);",
  );
  // v2.2: the model and effort asked for and in use.
  try {
    db.exec("ALTER TABLE subagents ADD COLUMN opts TEXT");
  } catch {
    /* already there */
  }
  const q = {
    all: db.prepare("SELECT * FROM subagents ORDER BY created_at"),
    upsert: db.prepare(
      "INSERT INTO subagents (handle, parent, provider, provider_name, task, cwd, status, error, created_at, updated_at, transcript, opts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(handle) DO UPDATE SET status=excluded.status, error=excluded.error, updated_at=excluded.updated_at, transcript=excluded.transcript, opts=excluded.opts",
    ),
    del: db.prepare("DELETE FROM subagents WHERE handle = ?"),
    getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
    setSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  };
  const setting = (k, fb) => {
    const r = q.getSetting.get(k);
    try {
      return r ? JSON.parse(r.value) : fb;
    } catch {
      return fb;
    }
  };
  const setSetting = (k, v) => q.setSetting.run(k, JSON.stringify(v));

  // handle -> record. Live fields (client, waiters, queue) are not saved.
  const subs = new Map();
  for (const r of q.all.all()) {
    let rows = [];
    try {
      rows = JSON.parse(r.transcript || "[]");
    } catch {
      rows = [];
    }
    const wasLive = ["busy", "starting", "ready"].includes(r.status);
    let opts = {};
    try {
      opts = JSON.parse(r.opts || "{}") || {};
    } catch {
      opts = {};
    }
    subs.set(r.handle, {
      want: opts.want || {}, using: opts.using || {},
      handle: r.handle, parent: r.parent, provider: r.provider, providerName: r.provider_name || r.provider, task: r.task || "", cwd: r.cwd || "",
      status: wasLive ? "stopped" : r.status || "stopped", error: r.error || "", createdAt: r.created_at, updatedAt: r.updated_at, rows,
      client: null, sessionId: "", waiters: new Set(), queue: [], introduced: rows.length > 0, sessionUsed: false,
    });
  }

  let alive = true;
  const saveTimers = new Map();
  function save(s, now) {
    clearTimeout(saveTimers.get(s.handle));
    const run = () => {
      saveTimers.delete(s.handle);
      if (!subs.has(s.handle)) return;
      try {
        q.upsert.run(s.handle, s.parent, s.provider, s.providerName, s.task, s.cwd, s.status, s.error, s.createdAt, s.updatedAt, JSON.stringify(s.rows.slice(-ROWS_MAX)), JSON.stringify({ want: s.want || {}, using: s.using || {} }));
      } catch (e) {
        ctx.log("subagents: save failed " + errText(e));
      }
    };
    if (now) run();
    else saveTimers.set(s.handle, setTimeout(run, 1000));
  }

  // Tell the window something changed, at most twice a second.
  let changeTimer = 0;
  function changed() {
    if (changeTimer || !alive) return;
    changeTimer = setTimeout(() => {
      changeTimer = 0;
      if (alive) ctx.send("changed", { at: Date.now() });
    }, 500);
  }

  ctx.dispose(() => {
    alive = false;
    clearTimeout(changeTimer);
    // Save only what changed since its last save: running ones and pending writes.
    for (const s of subs.values()) {
      const dirty = Boolean(s.client) || saveTimers.has(s.handle);
      if (s.client) {
        stopClient(s);
        s.status = "stopped";
        s.updatedAt = Date.now();
      }
      for (const fn of s.waiters) fn("stopped");
      s.waiters.clear();
      if (dirty) save(s, true);
    }
    for (const t of saveTimers.values()) clearTimeout(t);
    try {
      db.close();
    } catch {
      /* closed */
    }
  });

  // ---- Which MCP servers subagents get ----

  // Built-in and plugin servers: in-app ones (run through
  // jagents-plugin-mcp.cjs) and outside ones from plugin.json. jagents and
  // subagents are never offered.
  async function availableServers() {
    const st = await ctx.hub("list_plugins", {});
    const out = [];
    for (const p of (st.builtins || []).concat(st.safeMode ? [] : st.plugins || [])) {
      if (!p.enabled) continue;
      for (const s of p.appServers || []) if (!BLOCKED_SERVERS.has(s.name)) out.push({ name: s.name, plugin: p.name, kind: "app" });
      if ((p.mcpServers || []).length) {
        let json = {};
        try {
          json = JSON.parse(fs.readFileSync(path.join(p.builtin ? path.join(__dirname, "..") : st.dir, p.id, "plugin.json"), "utf8"));
        } catch {
          json = {};
        }
        for (const [name, def] of Object.entries(json.mcpServers || {})) if (!BLOCKED_SERVERS.has(name)) out.push({ name, plugin: p.name, kind: "external", def });
      }
    }
    return out;
  }

  // Default set: the built-in browser only. The page changes it.
  async function allowedServers() {
    const allow = setting("allowedServers", null);
    const list = await availableServers();
    return list.map((s) => Object.assign(s, { allowed: allow ? allow.includes(s.name) : s.name === "browser" }));
  }

  async function mcpEntriesFor(s) {
    const node = agentsLib.nodePath();
    const out = [];
    for (const srv of await allowedServers()) {
      if (!srv.allowed) continue;
      if (srv.kind === "app") {
        const env = [
          { name: "JAGENTS_SERVER", value: srv.name },
          { name: "JAGENTS_PANE_ID", value: "subagent:" + s.handle },
          { name: "JAGENTS_HUB_FILE", value: path.join(HOME_DIR, "hub.json") },
        ];
        if (!node) env.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
        out.push({ name: srv.name, command: node || process.execPath, args: [path.join(HOME_DIR, "jagents-plugin-mcp.cjs")], env });
      } else {
        out.push({ name: srv.name, command: srv.def.command, args: srv.def.args || [], env: Object.entries(srv.def.env || {}).map(([name, value]) => ({ name, value: String(value) })) });
      }
    }
    return out;
  }

  // ---- Running a subagent ----

  function push(s, row) {
    s.rows.push(Object.assign({ at: Date.now() }, row));
    if (s.rows.length > ROWS_MAX) s.rows.splice(0, s.rows.length - ROWS_MAX);
  }

  function onUpdate(s, params) {
    const u = (params && params.update) || {};
    const kind = u.sessionUpdate;
    const last = s.rows[s.rows.length - 1];
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const text = u.content && u.content.type === "text" ? String(u.content.text || "") : "";
      if (!text) return;
      const role = kind === "agent_message_chunk" ? "assistant" : "thought";
      if (last && last.role === role) last.text = (last.text + text).slice(-TEXT_MAX);
      else push(s, { role, text });
    } else if (kind === "tool_call") {
      push(s, { role: "tool", id: u.toolCallId, text: String(u.title || "tool"), status: u.status || "in_progress" });
    } else if (kind === "tool_call_update") {
      for (let i = s.rows.length - 1; i >= 0; i--) {
        const r = s.rows[i];
        if (r.role === "tool" && r.id === u.toolCallId) {
          if (u.status) r.status = u.status;
          if (u.title) r.text = String(u.title);
          break;
        }
      }
    } else return;
    s.updatedAt = Date.now();
    save(s);
    changed();
  }

  function finishTurn(s, why) {
    for (const fn of [...s.waiters]) fn(why);
    changed();
  }

  function stopClient(s) {
    if (ctx.permissions) ctx.permissions.cancel(s.handle);
    if (!s.client) return;
    const c = s.client;
    s.client = null;
    try {
      c.stop();
    } catch {
      /* already gone */
    }
  }

  // ---- Models and effort ----
  //
  // Both agent clients report effort for their current model (effortState:
  // levels, current) and set it (setEffort): Claude Code the way /effort does,
  // ACP agents through the effort option they advertise. Detect also records
  // each model's own levels where they differ per model (Claude Code, Cursor).

  const isClaude = (id) => {
    const a = agentsLib.acpAgent(id);
    return Boolean(a && a.native === "claude-sdk");
  };

  // What this running client offers: {models: [{id, name, efforts?}], model,
  // efforts: [{value, name}] (for the current model), effort, effortVia}.
  function offers(client) {
    const st = client.effortState();
    const info = client.modelInfo || null; // Claude Code: each model's levels
    const models = (client.models.availableModels || []).map((m) => {
      const out = { id: m.modelId, name: m.name || m.modelId };
      if (info) {
        const r = info.find((x) => x && x.value === m.modelId) || {};
        out.efforts = r.supportsEffort === false ? [] : r.supportedEffortLevels || [];
      }
      return out;
    });
    return { models, model: client.models.currentModelId || "", efforts: st.levels, effort: st.current, effortVia: st.via };
  }

  const setEffort = (client, level) => client.setEffort(level, client.sessionId);

  // Model and effort for a session: the spawn's own choice, else the saved default.
  async function applyChoices(client, providerId, want) {
    const notes = [];
    const def = (setting("defaults", {}) || {})[providerId] || {};
    const model = want.model || def.model || "";
    const effort = want.effort || def.effort || "";
    if (model) {
      try {
        await client.setModel(model, client.sessionId);
      } catch (e) {
        notes.push("Model " + model + " not used: " + errText(e));
      }
    }
    if (effort) {
      try {
        await setEffort(client, effort);
      } catch (e) {
        notes.push("Effort " + effort + " not used: " + errText(e));
      }
    }
    const o = offers(client);
    return { model: o.model, effort: o.effort, notes };
  }

  // Cursor saves the model and effort it is set to in its config folder, so
  // each Cursor subagent gets its own copy of the user's Cursor config (sign-in
  // and settings) and never changes the user's own model or effort. The copy
  // has no mcp.json, so the user's global Cursor MCP servers stay out too.
  const cursorDir = (key) => path.join(ctx.dataDir, "cursor", String(key).replace(/[^\w.-]+/g, "_"));
  function cursorConfig(key) {
    const dir = cursorDir(key);
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor"), "cli-config.json");
    try {
      fs.copyFileSync(src, path.join(dir, "cli-config.json"));
    } catch {
      /* not signed in yet; Cursor says so */
    }
    return dir;
  }

  // Starts an agent process with a session. Used for subagents and for Detect.
  // onPerm answers the agent's permission requests; Claude Code then runs its
  // default checks and asks through it for everything they would ask about.
  async function openClient(providerId, cwd, mcpServers, extraEnv, onUpd, key, onPerm) {
    const agent = agentsLib.acpAgent(providerId);
    if (!agent) throw new Error("Unknown provider " + providerId + ".");
    const spec = agentsLib.acpSpawnSpec(providerId);
    const opts = { harnessId: agent.id, dataRoot: ctx.dataDir, cwd, mcpServers, disallowedTools: CLAUDE_BLOCKED_TOOLS, onUpdate: onUpd || (() => {}) };
    if (onPerm) Object.assign(opts, { onPermission: onPerm, permissionMode: "ask" });
    const client = agent.native === "claude-sdk" ? new SubagentClaude(opts) : new AcpClient(opts);
    const env = Object.assign({}, spec.env, { JAGENTS_HUB_FILE: DEAD_HUB, JAGENTS_PANE_ID: "" }, extraEnv);
    if (agent.id === "cursor") env.CURSOR_CONFIG_DIR = cursorConfig(key || "detect");
    client.start({ command: spec.command, args: spec.args, cwd, env });
    return client;
  }

  // Cursor lists each model's own settings (its effort levels) on request.
  async function cursorModelEfforts(client) {
    const out = new Map();
    try {
      const res = await client.request("cursor/list_available_models", {});
      for (const m of (res && res.models) || []) {
        const eo = (m.configOptions || []).find((o) => o && o.category === "thought_level");
        const opts = eo ? (eo.options || []).flatMap((o) => (Array.isArray(o && o.options) ? o.options : [o])) : [];
        out.set(m.value, opts.filter((o) => o && typeof o.value === "string" && o.value !== "default").map((o) => ({ value: o.value, name: o.name || o.value })));
      }
    } catch {
      /* older Cursor: one list for all */
    }
    return out;
  }

  // Detect: start the agent with no tools, read what it offers, stop it.
  const detecting = new Map();
  function detect(providerId) {
    if (detecting.has(providerId)) return detecting.get(providerId);
    const run = (async () => {
      let client = null;
      try {
        client = await openClient(providerId, os.homedir(), [], { JAGENTS_SUBAGENT: "detect" });
        await client.initialize();
        await client.newSession({ cwd: os.homedir(), mcpServers: [] });
        const o = offers(client);
        let models = o.models;
        let efforts = o.efforts;
        if (providerId === "cursor") {
          const per = await cursorModelEfforts(client);
          if (per.size) {
            const names = new Map();
            models = models.map((m) => {
              const list = per.get(m.id) || [];
              for (const e of list) names.set(e.value, e.name);
              return Object.assign({}, m, { efforts: list.map((e) => e.value) });
            });
            efforts = [...names].map(([value, name]) => ({ value, name }));
          }
        } else if (isClaude(providerId)) {
          const names = new Map();
          const known = new Map(o.efforts.map((e) => [e.value, e.name]));
          for (const m of models) for (const v of m.efforts) names.set(v, known.get(v) || v);
          efforts = [...names].map(([value, name]) => ({ value, name }));
        }
        const entry = { at: Date.now(), models, defaultModel: o.model, efforts, defaultEffort: o.effort, effortVia: o.effortVia || (efforts.length ? "Model setting" : ""), error: "" };
        setSetting("catalog:" + providerId, entry);
        return entry;
      } catch (e) {
        const entry = Object.assign({}, setting("catalog:" + providerId, {}) || {}, { at: Date.now(), error: errText(e).slice(0, 400) });
        setSetting("catalog:" + providerId, entry);
        return entry;
      } finally {
        if (client) {
          try {
            client.stop();
          } catch {
            /* gone */
          }
        }
        detecting.delete(providerId);
        changed();
      }
    })();
    detecting.set(providerId, run);
    changed();
    return run;
  }

  // On/off: all subagents, and each provider. Off blocks new subagents and
  // messages; a turn already running finishes.
  const isOn = () => setting("enabled", true) !== false;
  const providerOn = (id) => !(setting("providersOff", []) || []).includes(id);

  function controlPanel() {
    const defaults = setting("defaults", {}) || {};
    return {
      on: isOn(),
      providers: agentsLib.listAcpAgents().map((a) => ({
        provider: a.id, name: a.name, installed: a.available, install: a.available ? undefined : a.install, claude: a.native === "claude-sdk",
        enabled: providerOn(a.id), catalog: setting("catalog:" + a.id, null), detecting: detecting.has(a.id), defaults: defaults[a.id] || {},
      })),
    };
  }

  async function startSession(s) {
    const mcpServers = await mcpEntriesFor(s);
    let client = null;
    // Its permission requests go to the parent's thread, which shows who asks.
    const onPerm = ctx.permissions ? (params) => ctx.permissions.ask({ parent: s.parent, handle: s.handle, agentName: s.providerName, harnessId: s.provider, params }) : null;
    client = await openClient(s.provider, s.cwd, mcpServers, { JAGENTS_SUBAGENT: s.handle, JAGENTS_SUBAGENT_PARENT: s.parent }, (p) => s.client === client && onUpdate(s, p), s.handle, onPerm);
    s.client = client;
    s.status = "starting";
    changed();
    const onExit = () => {
      if (s.client !== client) return;
      s.client = null;
      if (ctx.permissions) ctx.permissions.cancel(s.handle);
      if (s.status === "busy") {
        s.status = "error";
        s.error = "The agent exited mid-turn.";
      } else s.status = "stopped";
      s.updatedAt = Date.now();
      save(s, true);
      finishTurn(s, s.status);
    };
    if (typeof client.onExit === "function") client.onExit(onExit);
    else if (client.child) client.child.on("exit", onExit);
    try {
      await client.initialize();
      const created = await client.newSession({ cwd: s.cwd, mcpServers });
      s.sessionId = created.sessionId || created.session_id || "";
      if (!client.sessionId) client.sessionId = s.sessionId;
      const got = await applyChoices(client, s.provider, s.want || {});
      s.using = { model: got.model, effort: got.effort };
      for (const n of got.notes) push(s, { role: "system", text: n });
    } catch (e) {
      stopClient(s);
      throw e;
    }
    s.sessionUsed = false;
    s.status = "ready";
    s.error = "";
  }

  function intro(s) {
    return (
      "You are " + s.handle + ", a subagent that belongs to " + s.parent + " in JAgents. " + s.parent + " started you, gives you your work, and reads your replies. " +
      "You cannot start agents or message other agents. If you need something from anyone else, say so in your reply and " + s.parent + " will handle it. " +
      "Work in " + s.cwd + ". When you finish, reply with a short summary of what you did and found."
    );
  }

  function recap(s) {
    const last = s.rows.filter((r) => r.role === "user" || r.role === "assistant").slice(-6);
    if (!last.length) return "";
    return "Your earlier session ended. The last messages were:\n" + last.map((r) => (r.role === "user" ? s.parent + ": " : "You: ") + String(r.text).slice(0, 1500)).join("\n\n");
  }

  async function runTurn(s, text) {
    s.status = "starting";
    if (!s.client) await startSession(s);
    const parts = [];
    if (!s.introduced) parts.push(intro(s));
    else if (!s.sessionUsed) {
      const r = recap(s);
      parts.push(intro(s));
      if (r) parts.push(r);
    }
    parts.push((parts.length ? "Message from " + s.parent + ":\n" : "") + text);
    s.introduced = true;
    s.sessionUsed = true;
    push(s, { role: "user", text });
    s.status = "busy";
    s.updatedAt = Date.now();
    save(s, true);
    changed();
    try {
      const res = await s.client.promptWithRecovery(parts.join("\n\n"), s.sessionId, {});
      if (res && res.stopReason === "cancelled") push(s, { role: "system", text: "Stopped by " + s.parent + "." });
      s.status = s.client ? "ready" : "stopped";
    } catch (e) {
      push(s, { role: "error", text: errText(e) });
      s.status = s.client && s.client.started ? "ready" : "error";
      s.error = errText(e);
    }
    s.updatedAt = Date.now();
    save(s, true);
    const next = s.queue.shift();
    if (next && alive) deliver(s, next);
    else finishTurn(s, s.status);
  }

  function deliver(s, text) {
    if (s.status === "busy" || s.status === "starting") {
      s.queue.push(text);
      changed();
      return { queued: s.queue.length };
    }
    runTurn(s, text).catch((e) => {
      s.status = "error";
      s.error = errText(e);
      push(s, { role: "error", text: s.error });
      s.updatedAt = Date.now();
      save(s, true);
      finishTurn(s, "error");
    });
    return { queued: 0 };
  }

  function lastReply(s) {
    for (let i = s.rows.length - 1; i >= 0; i--) {
      const r = s.rows[i];
      if (r.role === "user") break;
      if (r.role === "assistant" && r.text.trim()) return r.text.trim();
    }
    return "";
  }

  const busy = (s) => s.status === "busy" || s.status === "starting" || s.queue.length > 0;

  function waitFor(s, ms) {
    if (!busy(s)) return Promise.resolve("idle");
    return new Promise((resolve) => {
      const fn = (why) => {
        if (busy(s)) return;
        clearTimeout(t);
        s.waiters.delete(fn);
        resolve(why);
      };
      const t = setTimeout(() => {
        s.waiters.delete(fn);
        resolve("timeout");
      }, ms);
      s.waiters.add(fn);
    });
  }

  function view(s, full) {
    const out = {
      handle: s.handle, label: "Subagent of " + s.parent, parent: s.parent, provider: s.provider, providerName: s.providerName,
      status: s.status, error: s.error || undefined, task: s.task, cwd: s.cwd, queued: s.queue.length || undefined,
      model: (s.using && s.using.model) || (s.want && s.want.model) || undefined, effort: (s.using && s.using.effort) || (s.want && s.want.effort) || undefined,
      createdAt: s.createdAt, updatedAt: s.updatedAt, reply: lastReply(s).slice(0, full ? TEXT_MAX : 600),
    };
    if (full) out.rows = s.rows;
    return out;
  }

  // ---- Ownership ----

  function needParent(caller) {
    if (!caller || !caller.handle) throw new Error("Only agents started by JAgents can have subagents.");
    return caller.handle;
  }

  // A parent names its subagent by full handle (claude-code-17/droid-1) or short (droid-1).
  function own(caller, ref) {
    const parent = needParent(caller);
    const key = String(ref || "").trim().replace(/^@/, "");
    const s = subs.get(key) || subs.get(parent + "/" + key);
    if (!s) throw new Error("No subagent " + key + ". Call subagents.list to see yours.");
    if (s.parent !== parent) throw new Error(s.handle + " belongs to " + s.parent + ". Only its parent can reach it; message " + s.parent + " instead.");
    return s;
  }

  function nextHandle(parent, provider) {
    const short = provider === "factory-droid" ? "droid" : provider;
    let n = 1;
    while (subs.has(parent + "/" + short + "-" + n)) n++;
    return parent + "/" + short + "-" + n;
  }

  // Providers with their models, effort levels and the user's defaults.
  function providers() {
    const cp = controlPanel();
    return {
      subagentsOn: cp.on,
      note: cp.on ? undefined : OFF_TEXT,
      providers: cp.providers.map((p) => {
        const models = p.catalog && p.catalog.models ? p.catalog.models : null;
        const perModel = models && models.some((m) => Array.isArray(m.efforts) && m.efforts.length);
        return {
          provider: p.provider, name: p.name, installed: p.installed, install: p.install, enabled: p.enabled,
          defaultModel: p.defaults.model || undefined, defaultEffort: p.defaults.effort || undefined,
          models: models ? models.map((m) => m.id) : undefined,
          efforts: p.catalog && p.catalog.efforts ? p.catalog.efforts.map((e) => e.value) : undefined,
          effortsByModel: perModel ? Object.fromEntries(models.filter((m) => m.efforts && m.efforts.length).map((m) => [m.id, m.efforts])) : undefined,
          note: !p.enabled ? "Turned off by the user." : !p.catalog ? (p.installed ? "Models and effort not detected yet (Subagents page > Settings > Detect)." : undefined) : p.catalog.error || undefined,
        };
      }),
      shortNames: ALIASES,
    };
  }

  const OFF_TEXT = "The user turned subagents off in JAgents (Subagents page > Settings). Do the work yourself.";

  async function spawn(args, caller) {
    const parent = needParent(caller);
    if (!isOn()) throw new Error(OFF_TEXT);
    const task = String(args.task || "").trim();
    if (!task) throw new Error("task is empty.");
    const raw = String(args.provider || "").trim().toLowerCase();
    const agent = agentsLib.acpAgent(ALIASES[raw] || raw);
    if (!agent) throw new Error("Unknown provider " + raw + ". Call subagents.providers.");
    if (!providerOn(agent.id)) throw new Error("The user turned off " + agent.name + " subagents. Pick another provider (subagents.providers).");
    const avail = agentsLib.listAcpAgents().find((a) => a.id === agent.id);
    if (!avail || !avail.available) throw new Error(agent.name + " is not installed. " + agent.install);
    const live = [...subs.values()].filter((s) => s.parent === parent && s.client).length;
    if (live >= MAX_LIVE_PER_PARENT) throw new Error("You already have " + live + " running subagents. Close one (subagents.stop with close) first.");
    const cwd = String(args.cwd || caller.cwd || os.homedir());
    if (!fs.existsSync(cwd)) throw new Error("Folder not found: " + cwd);
    const want = { model: String(args.model || "").trim(), effort: String(args.effort || "").trim().toLowerCase() };
    const s = {
      want, using: {},
      handle: nextHandle(parent, agent.id), parent, provider: agent.id, providerName: agent.name, task, cwd, status: "idle", error: "",
      createdAt: Date.now(), updatedAt: Date.now(), rows: [], client: null, sessionId: "", waiters: new Set(), queue: [], introduced: false, sessionUsed: false,
    };
    subs.set(s.handle, s);
    save(s, true);
    ctx.log("subagents: " + parent + " started " + s.handle);
    deliver(s, task);
    changed();
    if (args.wait === false) return Object.assign(view(s), { note: "Call subagents.wait with agent " + s.handle + " for its reply." });
    const why = await waitFor(s, clampWait(args.timeout_seconds));
    return Object.assign(view(s), { reply: lastReply(s).slice(0, TEXT_MAX) }, why === "timeout" ? { hint: "Still working. Call subagents.wait with agent " + s.handle + "." } : {});
  }

  // ---- MCP server for parents ----

  const srv = ctx.mcp.server("subagents", {
    description: "Your own subagents: start Claude Code, Codex, Factory Droid, Devin, Cursor, Gemini, OpenCode or another installed agent on a task. Only you can reach your subagents.",
  });

  srv.tool({
    name: "providers",
    description: "Agents spawn can start: whether each is installed, its models and effort levels, and the user's default model and effort. Short names: droid, claude, codex, cursor, devin, gemini, opencode.",
    inputSchema: { type: "object", properties: {} },
    handler: () => providers(),
  });

  srv.tool({
    name: "spawn",
    description:
      "Start a subagent that belongs to you: Claude Code, Codex, Factory Droid (droid), Devin, Cursor, Gemini, OpenCode or another installed agent. It runs in the background (no pane, not visible to other agents) and only you can message, read, wait on or stop it. It cannot start agents itself. With wait (default true) this returns its reply when it finishes or after timeout_seconds.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Provider id or short name: claude, codex, droid, devin, cursor, gemini, opencode" },
        task: { type: "string", description: "What it should do. Be specific; it does not see your conversation." },
        cwd: { type: "string", description: "Working folder (defaults to yours)" },
        model: { type: "string", description: "Model id for this subagent (see providers). Default: the user's default for that provider." },
        effort: { type: "string", description: "Effort level, e.g. low, medium, high, xhigh, max (see providers). Default: the user's default for that provider." },
        wait: { type: "boolean", description: "Wait for the reply (default true)" },
        timeout_seconds: { type: "number", description: "How long to wait (default 50, max 900)" },
      },
      required: ["provider", "task"],
    },
    handler: (args, caller) => spawn(args, caller),
  });

  srv.tool({
    name: "list",
    description: "Your subagents with their status and the start of their latest reply (subagents.wait or read for all of it).",
    inputSchema: { type: "object", properties: {} },
    handler: (_args, caller) => {
      const parent = needParent(caller);
      return { you: parent, subagents: [...subs.values()].filter((s) => s.parent === parent).map((s) => view(s)) };
    },
  });

  srv.tool({
    name: "wait",
    description: "Wait until one of your subagents finishes its turn, then return its reply.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, timeout_seconds: { type: "number", description: "Default 50, max 900" } }, required: ["agent"] },
    handler: async (args, caller) => {
      const s = own(caller, args.agent);
      const why = await waitFor(s, clampWait(args.timeout_seconds));
      return Object.assign(view(s), { reply: lastReply(s).slice(0, TEXT_MAX) }, why === "timeout" ? { hint: "Still working. Call subagents.wait again." } : {});
    },
  });

  srv.tool({
    name: "send",
    description: "Send a follow-up message to one of your subagents. If it is busy the message waits for its turn. A stopped subagent starts a new session with a recap.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, message: { type: "string" } }, required: ["agent", "message"] },
    handler: (args, caller) => {
      const s = own(caller, args.agent);
      if (!isOn()) throw new Error(OFF_TEXT);
      if (!providerOn(s.provider)) throw new Error("The user turned off " + s.providerName + " subagents.");
      const text = String(args.message || "").trim();
      if (!text) throw new Error("message is empty.");
      const out = deliver(s, text);
      return { to: s.handle, queued: out.queued, note: out.queued ? "It is busy; your message is queued." : "Sent. Call subagents.wait for the reply." };
    },
  });

  srv.tool({
    name: "read",
    description: "Read one of your subagents' transcript: your messages, its replies and its tool calls.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, limit: { type: "number", description: "Rows from the end (default 30)" } }, required: ["agent"] },
    handler: (args, caller) => {
      const s = own(caller, args.agent);
      const n = Math.min(ROWS_MAX, Math.max(1, Number(args.limit) || 30));
      return Object.assign(view(s), { rows: s.rows.slice(-n).map((r) => ({ role: r.role, text: String(r.text).slice(0, 4000), status: r.status })) });
    },
  });

  srv.tool({
    name: "stop",
    description: "Stop one of your subagents' current turn. close: true ends its session; remove: true also deletes it and its transcript.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, close: { type: "boolean" }, remove: { type: "boolean" } }, required: ["agent"] },
    handler: async (args, caller) => {
      const s = own(caller, args.agent);
      s.queue.length = 0;
      if (ctx.permissions) ctx.permissions.cancel(s.handle);
      if (s.client && s.status === "busy") {
        try {
          await s.client.cancel(s.sessionId);
        } catch {
          /* nothing running */
        }
      }
      if (args.close || args.remove) {
        stopClient(s);
        s.status = "stopped";
        s.updatedAt = Date.now();
        finishTurn(s, "stopped");
      }
      if (args.remove) {
        subs.delete(s.handle);
        q.del.run(s.handle);
        if (s.provider === "cursor") fs.rm(cursorDir(s.handle), { recursive: true, force: true }, () => {});
      } else save(s, true);
      changed();
      return { handle: s.handle, stopped: true, closed: Boolean(args.close || args.remove), removed: Boolean(args.remove) };
    },
  });

  // ---- The window (view only) ----

  ctx.handle("state", async () => {
    const res = await ctx.hub("list_agents", {});
    return { agents: res.agents || [], subagents: [...subs.values()].map((s) => view(s)) };
  });
  ctx.handle("transcript", ({ handle }) => {
    const s = subs.get(String(handle || ""));
    if (!s) throw new Error("That subagent is gone.");
    return view(s, true);
  });
  ctx.handle("control", () => controlPanel());
  ctx.handle("detect", async ({ provider }) => {
    await detect(String(provider || ""));
    return controlPanel();
  });
  ctx.handle("set-default", ({ provider, model, effort }) => {
    const all = setting("defaults", {}) || {};
    const cur = Object.assign({}, all[provider] || {});
    if (model !== undefined) cur.model = String(model || "");
    if (effort !== undefined) cur.effort = String(effort || "");
    if (!cur.model) delete cur.model;
    if (!cur.effort) delete cur.effort;
    if (Object.keys(cur).length) all[provider] = cur;
    else delete all[provider];
    setSetting("defaults", all);
    return controlPanel();
  });
  ctx.handle("set-enabled", ({ enabled }) => {
    setSetting("enabled", Boolean(enabled));
    changed();
    return controlPanel();
  });
  ctx.handle("set-provider-enabled", ({ provider, enabled }) => {
    const off = new Set(setting("providersOff", []) || []);
    if (enabled) off.delete(String(provider));
    else off.add(String(provider));
    setSetting("providersOff", [...off]);
    return controlPanel();
  });
  ctx.handle("servers", () => allowedServers().then((list) => list.map((s) => ({ name: s.name, plugin: s.plugin, kind: s.kind, allowed: s.allowed }))));
  ctx.handle("set-servers", async ({ allowed }) => {
    setSetting("allowedServers", (Array.isArray(allowed) ? allowed : []).map(String).filter((n) => !BLOCKED_SERVERS.has(n)));
    return (await allowedServers()).map((s) => ({ name: s.name, plugin: s.plugin, kind: s.kind, allowed: s.allowed }));
  });

  ctx.log("subagents: ready, " + subs.size + " saved subagents");
};
