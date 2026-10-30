"use strict";

// ACP chat sessions (chat panes, threads, and hub-spawned subagents). Adapted
// from Plugin App's acp-host.cjs: spawn the agent, initialize, session/load when
// the agent can and the chat has a saved session, otherwise session/new, then
// stream session/update into a transcript the renderer draws. JAgents adds a
// per-chat working folder, a parent (the agent that spawned a subagent),
// waitTurn for the hub, a delivery queue for messages that arrive mid-turn, and
// incoming handoffs from other panes.

const { randomUUID } = require("node:crypto");
const { AcpClient } = require("../lib/acp-client");
const { ClaudeSdkClient } = require("../lib/claude-sdk-client");
const { acpAgent, listAcpAgents, acpSpawnSpec } = require("../lib/agents");

// Claude Code chats use the native Agent SDK client; everything else speaks ACP.
function makeClient(harnessId, options) {
  const agent = acpAgent(harnessId);
  return agent && agent.native === "claude-sdk" ? new ClaudeSdkClient(options) : new AcpClient(options);
}

// Exit and stderr hooks: the native client spawns its process later, so it
// takes callbacks; ACP clients expose the child right after start().
function watchClient(client, onStderr, onExit) {
  if (typeof client.onExit === "function") {
    client.onStderr(onStderr);
    client.onExit(onExit);
  } else if (client.child) {
    if (client.child.stderr) client.child.stderr.on("data", (c) => onStderr(c.toString("utf8")));
    client.child.on("exit", onExit);
  }
}
const { handoffPrompt, toolDetail } = require("../lib/acp-handoff");
const { normalMode, listPermissionOptions, autoPermissionOption } = require("../lib/acp-permissions");
const { saveAttachments, describeAttachments, attachmentsDir } = require("../lib/attachments");

const TRANSCRIPT_MAX = 800;
const HISTORY_MAX = 8000;

// Each row gets a short id so the chat can patch rows in place while they stream.
function rowId() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

function withIds(rows) {
  for (const row of rows) if (row && !row.id) row.id = rowId();
  return rows;
}

function lastRow(rows, test) {
  for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i])) return rows[i];
  return null;
}

// Devin's ACP server ignores session/new mcpServers and reads its config files,
// so the JAgents entry also goes into the cwd's local Devin config (as Plugin App does).
function writeDevinMcpConfig(cwd, entries) {
  const fs = require("node:fs");
  const path = require("node:path");
  if (!cwd || !entries.length) return;
  const dir = path.join(cwd, ".devin");
  const file = path.join(dir, "mcp_config.local.json");
  fs.mkdirSync(dir, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot read Devin MCP config. Existing config was not changed.");
  }
  const servers = Object.assign({}, current.mcpServers);
  for (const entry of entries) {
    const env = {};
    for (const item of entry.env || []) env[item.name] = item.value;
    servers[entry.name] = { command: entry.command, args: entry.args || [], env };
  }
  const tmp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, current, { mcpServers: servers }), null, 2));
  fs.renameSync(tmp, file);
  excludeFromGit(file);
}

// The Devin config holds plugin MCP env values, which can be API keys. When the
// working folder is a git repo, list the file in .git/info/exclude so it is
// never committed. Best effort: no git, or not a repo, leaves it as is.
function excludeFromGit(file) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const dir = path.dirname(file);
  let out;
  try {
    out = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel", "--git-path", "info/exclude"], { encoding: "utf8", windowsHide: true, timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return;
  }
  const [top, excludeRel] = out.split(/\r?\n/);
  if (!top || !excludeRel) return;
  const rel = path.relative(top, file).split(path.sep).join("/");
  if (!rel || rel.startsWith("..")) return;
  const exclude = path.resolve(dir, excludeRel);
  const line = "/" + rel;
  let text = "";
  try {
    text = fs.readFileSync(exclude, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") return;
  }
  if (text.split(/\r?\n/).includes(line)) return;
  try {
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, (text && !text.endsWith("\n") ? "\n" : "") + line + "\n");
  } catch {}
}

function createAcpHost(options) {
  const { dataRoot, db, emit, defaultCwd, mcpEntryFor, contextFor, disallowedFor } = options;
  const sessions = new Map();
  const probes = new Map();
  const saveTimers = new Map();
  const emitTimers = new Map();
  const turnWaiters = new Map(); // chatId -> Set<fn>
  const queues = new Map(); // chatId -> [{id, text, attachments, from}]
  const NO_CAPS = { image: false, audio: false, embeddedContext: false };
  // stopAll ran: nothing starts, queues, emits or sets a timer after it.
  let closed = false;
  let saveAfterStop = true;

  // prompt(chatId, "text", {from}) or prompt(chatId, {text, attachments}, {from}).
  // Attachments here are already saved (see saveAttachments).
  function promptArg(textIn, meta) {
    const obj = textIn && typeof textIn === "object" && !Array.isArray(textIn) ? textIn : { text: textIn };
    return {
      text: String(obj.text || ""),
      attachments: Array.isArray(obj.attachments) ? obj.attachments : [],
      from: String((meta && meta.from) || ""),
    };
  }

  function chatRecord(chatId) {
    const chat = db.getChat(chatId);
    if (!chat) throw new Error("That chat no longer exists.");
    return chat;
  }

  function snapshot(chatId) {
    const s = sessions.get(chatId);
    const chat = db.getChat(chatId);
    if (!chat) return null;
    return {
      chatId,
      title: chat.title,
      harnessId: chat.harnessId,
      handle: chat.handle,
      parentId: chat.parentId,
      cwd: chat.cwd,
      status: s ? s.status : "idle",
      error: s ? s.error : "",
      agentName: s ? s.agentName : (acpAgent(chat.harnessId) || {}).name || chat.harnessId,
      models: s && s.client ? s.client.models : { availableModels: [], currentModelId: "" },
      effort: effortView(s, chat),
      promptCapabilities: (s && s.client && s.client.promptCapabilities) || db.getSetting("agent-caps:" + chat.harnessId, null) || NO_CAPS,
      queued: (queues.get(chatId) || []).length,
      // Messages waiting for the turn to end; the user's own can be edited.
      queue: (queues.get(chatId) || []).map((q) => ({ id: q.id, text: q.text, from: q.from || "", files: (q.attachments || []).length })),
      permissionMode: permMode(chatId, chat),
      permissions: (waits.get(chatId) || []).map(permissionView),
      commands: (s && s.commands) || db.getSetting("agent-commands:" + chat.harnessId, null) || [],
      usage: (s && s.usage) || null,
      transcript: withIds(s ? s.transcript : chat.transcript),
      authMethods: s && s.status === "error" ? s.authMethods || [] : [],
    };
  }

  // ACP sign-in. The method a user picked is remembered per agent (in memory
  // with any key they typed; the method id alone in jagents.db), so later
  // starts sign in the same way without asking again.
  const authChoices = new Map();

  function authChoice(harnessId) {
    if (authChoices.has(harnessId)) return authChoices.get(harnessId);
    const methodId = db.getSetting("agent-auth:" + harnessId, "");
    return methodId ? { methodId, meta: null, env: {} } : null;
  }

  // What the chat shows for each sign-in method the agent offers. needsKey
  // marks methods that take a key the user types (an API key method, or an
  // env_var method that reads one from the environment).
  function authMethodView(m) {
    const meta = m._meta || {};
    const envVar = m.type === "env_var" ? String(m.varName || (Array.isArray(m.vars) && m.vars[0] && m.vars[0].name) || "") : "";
    return {
      id: m.id,
      name: String(m.name || m.id),
      description: String(m.description || ""),
      needsKey: Boolean(meta["api-key"] || envVar),
      keyLabel: envVar || (meta["api-key"] && meta["api-key"].provider ? meta["api-key"].provider + " API key" : "API key"),
      terminal: m.type === "terminal",
    };
  }

  function saveModelCatalog(harnessId, models) {
    if (models && Array.isArray(models.availableModels) && models.availableModels.length) {
      try {
        db.setSetting("agent-models:" + harnessId, models);
      } catch {
        /* best effort */
      }
    }
  }

  // What each agent's prompts can carry (images, embedded files), so chats show
  // it before the agent starts.
  function saveCaps(harnessId, client) {
    if (!client || !client.promptCapabilities) return;
    try {
      db.setSetting("agent-caps:" + harnessId, client.promptCapabilities);
    } catch {
      /* best effort */
    }
  }

  function modelPref(harnessId) {
    return String(db.getSetting("agent-model:" + harnessId, "") || "");
  }

  async function applyModelPref(harnessId, client, sessionId) {
    const pref = modelPref(harnessId);
    if (!pref || !client) return;
    if (!client.models.availableModels.some((m) => m.modelId === pref)) return;
    if (client.models.currentModelId === pref) return;
    try {
      await client.setModel(pref, sessionId);
    } catch {
      /* the agent declined; leave its own default */
    }
  }

  // ---- Effort ----
  //
  // A thread uses its agent's own effort until the user picks one for it
  // (chat-effort:<id>; "" goes back to the agent's own). A pick is applied when
  // the session opens and again after a model change, since some agents
  // (Cursor) reset effort to the new model's own default.
  //
  // Each agent's levels per model are kept (agent-efforts:<harness>, "*" for
  // agents with one list for every model), so threads show the picker before
  // their agent starts. The model probe and every session fill this in.

  function effortPref(chatId) {
    return String(db.getSetting("chat-effort:" + chatId, "") || "");
  }

  function effortCatalog(harnessId) {
    return db.getSetting("agent-efforts:" + harnessId, null);
  }

  // Levels for every model the client knows: Claude Code lists them per model,
  // Cursor answers cursor/list_available_models, other agents have one list.
  async function saveEffortCatalog(harnessId, client) {
    if (!client || typeof client.effortState !== "function") return;
    const all = Object.assign({}, effortCatalog(harnessId) || {});
    const NAMES = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
    if (Array.isArray(client.modelInfo)) {
      for (const m of client.modelInfo) {
        if (m && m.value) all[m.value] = m.supportsEffort === false ? [] : (m.supportedEffortLevels || []).map((v) => ({ value: v, name: NAMES[v] || v }));
      }
    } else if (harnessId === "cursor" && typeof client.request === "function") {
      try {
        const res = await client.request("cursor/list_available_models", {});
        for (const m of (res && res.models) || []) {
          const eo = (m.configOptions || []).find((o) => o && o.category === "thought_level");
          const opts = eo ? (eo.options || []).flatMap((o) => (Array.isArray(o && o.options) ? o.options : [o])) : [];
          all[m.value] = opts.filter((o) => o && typeof o.value === "string" && o.value !== "default").map((o) => ({ value: o.value, name: String(o.name || o.value) }));
        }
      } catch {
        /* older Cursor: the current model's list below */
      }
    }
    const model = client.models.currentModelId || "";
    const levels = client.effortState().levels;
    if (model && !all[model]) all[model] = levels;
    if (!Array.isArray(client.modelInfo) && harnessId !== "cursor") all["*"] = levels;
    if (JSON.stringify(all) === JSON.stringify(effortCatalog(harnessId) || {})) return;
    try {
      db.setSetting("agent-efforts:" + harnessId, all);
    } catch {
      /* best effort */
    }
  }

  function levelsFor(harnessId, model) {
    const all = effortCatalog(harnessId) || {};
    return all[model] || all["*"] || [];
  }

  function effortView(s, chat) {
    const id = chat.id || (s && s.chatId);
    const pref = effortPref(id);
    if (s && s.client && s.sessionId && typeof s.client.effortState === "function") return Object.assign(s.client.effortState(), { pref, live: true, known: true });
    const known = Boolean(effortCatalog(chat.harnessId));
    return { levels: levelsFor(chat.harnessId, modelPref(chat.harnessId)), current: "", via: "", pref, live: false, known };
  }

  async function applyEffortPref(s) {
    const c = s && s.client;
    if (!c || !s.sessionId || typeof c.effortState !== "function") return;
    await saveEffortCatalog(s.harnessId, c);
    const pref = effortPref(s.chatId);
    const st = c.effortState();
    if (!pref || st.current === pref || !st.levels.some((l) => l.value === pref)) return;
    try {
      await c.setEffort(pref, s.sessionId);
    } catch {
      /* the agent declined; keep its own */
    }
  }

  // level "" puts the thread back on the agent's own effort; a running agent
  // keeps the level it has until it starts again.
  async function setEffort(chatId, level) {
    chatRecord(chatId);
    const v = String(level || "");
    db.setSetting("chat-effort:" + chatId, v);
    const s = sessions.get(chatId);
    if (s && !s.disposed && s.client && s.sessionId && s.status !== "starting" && v) await s.client.setEffort(v, s.sessionId);
    emitState(chatId, true);
    return snapshot(chatId);
  }

  function mcpServersFor(chatId) {
    const entries = mcpEntryFor(chatId);
    return Array.isArray(entries) ? entries : entries ? [entries] : [];
  }

  function probeState(harnessId) {
    const p = probes.get(harnessId);
    return {
      harnessId,
      probing: Boolean(p && p.status === "probing"),
      error: p && p.status === "error" ? p.error : "",
      models: p && p.client ? p.client.models : db.getSetting("agent-models:" + harnessId, null),
      efforts: effortCatalog(harnessId),
      promptCapabilities: db.getSetting("agent-caps:" + harnessId, null) || NO_CAPS,
    };
  }

  function emitProbe(harnessId) {
    emit("acp-models", probeState(harnessId));
  }

  // A probe is a live session opened only to learn the agent's model list
  // before any chat exists. Unlike Plugin App, chats do not adopt it: each chat
  // has its own folder and MCP identity, so the probe stops once it has the list.
  async function probe(harnessId) {
    const id = String(harnessId || "");
    const agent = acpAgent(id);
    if (!agent) throw new Error("Unknown agent: " + id);
    const existing = probes.get(id);
    if (existing && (existing.status === "probing" || existing.status === "done")) return modelInfo(id);
    if (existing && existing.status === "error" && Date.now() - existing.failedAt < 15000) return modelInfo(id);
    let spec;
    try {
      spec = acpSpawnSpec(id);
    } catch {
      return modelInfo(id);
    }
    const p = { status: "probing", error: "", failedAt: 0, client: null };
    probes.set(id, p);
    emitProbe(id);
    (async () => {
      let stderr = "";
      try {
        const cwd = defaultCwd();
        const client = makeClient(id, { harnessId: id, dataRoot, cwd, mcpServers: [] });
        p.client = client;
        client.start({ command: spec.command, args: spec.args, cwd, env: spec.env });
        watchClient(client, (t) => (stderr = (stderr + t).slice(-2000)), () => {});
        await client.initialize();
        await client.newSession({ cwd, mcpServers: [] });
        saveModelCatalog(id, client.models);
        await saveEffortCatalog(id, client);
        p.models = client.models;
        saveCaps(id, client);
        p.status = "done";
      } catch (error) {
        p.status = "error";
        p.failedAt = Date.now();
        p.error = String(error.message || error) + (stderr ? " " + stderr.trim().split("\n").pop() : "");
      } finally {
        if (p.client) {
          const models = p.client.models;
          p.client.stop();
          p.client = null;
          if (p.status === "done") p.models = models;
        }
      }
      emitProbe(id);
    })();
    return modelInfo(id);
  }

  // ---- Permissions ----
  //
  // A chat's mode (chat-perm:<id>) decides which of the agent's permission
  // requests JAgents answers by itself (lib/acp-permissions.js). The rest wait
  // as cards in the chat until the user picks one of the agent's options, the
  // turn is stopped, or the agent goes away. Subagents started by other agents
  // have nobody watching them, so they default to Auto.
  //
  // Subagents from the subagents plugin ask through their parent's thread:
  // the parent's mode decides, and the card names the subagent that asks.
  // Waiting requests live per thread (waits), apart from the session, so a
  // subagent's request outlasts its parent's turn.

  const waits = new Map(); // chatId -> [request]

  function permMode(chatId, chat) {
    const saved = db.getSetting("chat-perm:" + chatId, "");
    if (saved) return normalMode(saved);
    const c = chat || db.getChat(chatId);
    return c && c.parentId ? "auto" : normalMode(db.getSetting("perm-default", "ask"));
  }

  async function setPermissionMode(chatId, mode) {
    const chat = chatRecord(chatId);
    const m = normalMode(String(mode || ""));
    db.setSetting("chat-perm:" + chatId, m);
    const s = sessions.get(chatId);
    if (s && !s.disposed && s.client && typeof s.client.setPermissionMode === "function") {
      try {
        await s.client.setPermissionMode(m);
      } catch {
        /* applied on the next start */
      }
    }
    // Cards already waiting follow the new mode too.
    for (const p of (waits.get(chatId) || []).slice()) {
      const auto = autoPermissionOption(m, p.params);
      if (auto) settlePermission(chatId, p, { outcome: { outcome: "selected", optionId: auto } });
    }
    emitState(chat.id, true);
    return snapshot(chatId);
  }

  function permissionView(p) {
    return { id: p.id, toolCallId: p.toolCallId, title: p.title, kind: p.kind, input: p.input, description: p.description, diffs: p.diffs, options: p.options, defaultToNo: p.defaultToNo, from: p.from || null };
  }

  // A request from the chat's own agent (from empty) or from one of its
  // subagents (from: {handle, agentName, harnessId}).
  function askPermission(s, params) {
    return askIn(s.chatId, params, null, s.transcript, s.agentName);
  }

  function askIn(chatId, params, from, transcript, agentName) {
    const auto = autoPermissionOption(permMode(chatId), params);
    if (auto) return Promise.resolve({ outcome: { outcome: "selected", optionId: auto } });
    const call = (params && (params.toolCall || params.tool_call)) || {};
    const row = call.toolCallId && transcript ? lastRow(transcript, (r) => r.role === "tool" && r.toolCallId === call.toolCallId) : null;
    const detail = toolDetail(call);
    const options = listPermissionOptions(params).map((o) => ({ optionId: o.optionId, name: String(o.name || o.optionId), kind: o.kind }));
    if (!options.length) return Promise.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } });
    return new Promise((resolve) => {
      const p = {
        id: rowId(),
        toolCallId: String(call.toolCallId || ""),
        title: String(call.title || (row && row.title) || "Tool call"),
        kind: String(call.kind || (row && row.kind) || ""),
        input: detail.input || (row && row.input) || "",
        diffs: detail.diffs || (row && row.diffs) || null,
        description: String((params && params.description) || ""),
        defaultToNo: Boolean(params && params.defaultToNo),
        options,
        params,
        from,
        resolve,
      };
      waits.set(chatId, (waits.get(chatId) || []).concat([p]));
      const signal = params && params.signal;
      if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", () => settlePermission(chatId, p, { outcome: { outcome: "cancelled" } }), { once: true });
      emitState(chatId, true);
      emit("acp-attention", { chatId, kind: "permission", title: p.title, agentName: from ? from.handle + " (" + from.agentName + ")" : agentName });
    });
  }

  function settlePermission(chatId, p, result) {
    const list = waits.get(chatId) || [];
    if (!list.includes(p)) return;
    const rest = list.filter((x) => x !== p);
    if (rest.length) waits.set(chatId, rest);
    else waits.delete(chatId);
    p.resolve(result);
    emitState(chatId, true);
  }

  // Answers waiting requests as cancelled: the chat's own (a stop, the turn
  // ended), one subagent's, or all of them (the thread is gone).
  function cancelWaits(chatId, which) {
    for (const p of (waits.get(chatId) || []).slice()) {
      const own = !p.from;
      if (which === "all" || (which === "own" && own) || (which && which.handle && p.from && p.from.handle === which.handle)) settlePermission(chatId, p, { outcome: { outcome: "cancelled" } });
    }
  }

  function cancelPermissions(s) {
    if (s) cancelWaits(s.chatId, "own");
  }

  // The user picked one of the agent's options on a permission card.
  function answerPermission(chatId, permissionId, optionId) {
    const p = (waits.get(chatId) || []).find((x) => x.id === permissionId);
    if (!p) throw new Error("That request is no longer waiting.");
    if (!p.options.some((o) => o.optionId === optionId)) throw new Error("The agent did not offer that option.");
    settlePermission(chatId, p, { outcome: { outcome: "selected", optionId } });
    return snapshot(chatId);
  }

  // A subagent (subagents plugin) asks; its parent's thread decides. A parent
  // that is not a chat (a terminal agent) has no thread to show a card in, so
  // the global default mode applies and anything it would ask is allowed once,
  // as subagents always were.
  function askForSubagent(req) {
    const r = req || {};
    const parent = String(r.parent || "");
    const chat = db.listChats().find((c) => c.handle === parent || c.id === parent);
    const from = { handle: String(r.handle || "subagent"), agentName: String(r.agentName || r.harnessId || "Agent"), harnessId: String(r.harnessId || "") };
    if (!chat) {
      const auto = autoPermissionOption(normalMode(db.getSetting("perm-default", "ask")), r.params) || autoPermissionOption("auto", r.params);
      return Promise.resolve({ outcome: { outcome: "selected", optionId: auto } });
    }
    return askIn(chat.id, r.params, from, null, "");
  }

  function cancelSubagentPermissions(handle) {
    for (const chatId of Array.from(waits.keys())) cancelWaits(chatId, { handle: String(handle || "") });
  }

  // Output of a terminal the agent ran through this client, kept on its row.
  function fillTerminal(s, row) {
    if (!row.terminals || !s.client || typeof s.client.terminalText !== "function") return;
    const parts = [];
    let exitCode = null;
    for (const id of row.terminals) {
      const t = s.client.terminalText(id);
      if (!t) continue;
      if (t.output) parts.push(t.output);
      if (t.exitCode != null) exitCode = t.exitCode;
    }
    const text = parts.join("\n");
    if (text) row.terminalOutput = text.length > 12000 ? text.slice(-12000) : text;
    if (exitCode != null) row.exitCode = exitCode;
  }

  function notifyTurn(chatId) {
    const set = turnWaiters.get(chatId);
    if (!set) return;
    const s = sessions.get(chatId);
    if (s && (s.status === "busy" || s.status === "starting")) return;
    for (const fn of Array.from(set)) fn();
  }

  function emitState(chatId, now) {
    clearTimeout(emitTimers.get(chatId));
    if (closed) return;
    const fire = () => {
      emitTimers.delete(chatId);
      const snap = snapshot(chatId);
      if (snap) emit("acp-state", snap);
    };
    if (now) fire();
    else emitTimers.set(chatId, setTimeout(fire, 50));
  }

  function persist(s, now) {
    clearTimeout(saveTimers.get(s.chatId));
    const save = () => {
      saveTimers.delete(s.chatId);
      const chat = db.getChat(s.chatId);
      if (!chat) return;
      db.saveChat(Object.assign(chat, { acpSessionId: s.sessionId || chat.acpSessionId, transcript: s.transcript.slice(-TRANSCRIPT_MAX), title: s.title || chat.title }), { forHarness: s.harnessId });
    };
    // After stopAll no timer is set. A turn it ended still saves its last
    // rows while the database is open; nothing once another JAgents has it.
    if (closed) {
      if (now && saveAfterStop) {
        try {
          save();
        } catch {
          /* the database closed first */
        }
      }
      return;
    }
    if (now) save();
    else saveTimers.set(s.chatId, setTimeout(save, 400));
  }

  function push(s, row) {
    s.transcript.push(Object.assign({ id: rowId(), at: Date.now() }, row));
    if (s.transcript.length > TRANSCRIPT_MAX) s.transcript.splice(0, s.transcript.length - TRANSCRIPT_MAX);
    persist(s);
    emitState(s.chatId);
  }

  function onUpdate(s, params) {
    if (params && params.sessionId && s.sessionId && params.sessionId !== s.sessionId) return;
    if (s.replaying) return;
    const u = (params && params.update) || {};
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const textPart = u.content && u.content.type === "text" ? String(u.content.text || "") : "";
      if (!textPart) return;
      const role = kind === "agent_message_chunk" ? "agent" : "thought";
      const last = s.transcript[s.transcript.length - 1];
      if (last && last.role === role) last.text += textPart;
      else return push(s, { role, text: textPart });
    } else if (kind === "tool_call") {
      const row = Object.assign({ role: "tool", toolCallId: u.toolCallId, title: String(u.title || "Tool call"), status: u.status || "pending" }, toolDetail(u));
      fillTerminal(s, row);
      return push(s, row);
    } else if (kind === "tool_call_update") {
      const row = lastRow(s.transcript, (r) => r.role === "tool" && r.toolCallId === u.toolCallId);
      if (!row) return;
      if (u.status) row.status = u.status;
      if (u.title) row.title = String(u.title);
      const detail = toolDetail(u);
      for (const key of ["kind", "input", "output", "diffs", "terminals", "paths"]) if (detail[key]) row[key] = detail[key];
      fillTerminal(s, row);
    } else if (kind === "available_commands_update" && Array.isArray(u.availableCommands)) {
      s.commands = u.availableCommands
        .filter((c) => c && c.name)
        .slice(0, 300)
        .map((c) => ({ name: String(c.name).replace(/^\//, ""), description: String(c.description || ""), hint: c.input && c.input.hint ? String(c.input.hint) : "" }));
      try {
        db.setSetting("agent-commands:" + s.harnessId, s.commands);
      } catch {
        /* best effort */
      }
      return emitState(s.chatId);
    } else if (kind === "usage_update" && Number(u.size) > 0) {
      s.usage = { used: Number(u.used) || 0, size: Number(u.size) };
      return emitState(s.chatId);
    } else if (kind === "plan" && Array.isArray(u.entries)) {
      const existing = lastRow(s.transcript, (r) => r.role === "plan");
      const entries = u.entries.map((e) => ({ content: String(e.content || ""), status: e.status || "pending" }));
      if (existing && s.transcript.indexOf(existing) >= s.turnStart) existing.entries = entries;
      else return push(s, { role: "plan", entries });
    } else if (kind === "config_option_update" || kind === "current_model_update") {
      // models changed in the client
    } else {
      return;
    }
    persist(s);
    emitState(s.chatId);
  }

  function historyPrefix(rows) {
    const lines = [];
    for (const row of rows.slice(-60)) {
      const t = String(row.text || "").replace(/\s+/g, " ").trim().slice(0, 800);
      const files = row.role === "user" && row.attachments ? " " + describeAttachments(row.attachments) : "";
      if (row.role === "user" && (t || files)) lines.push("User: " + (t + files).trim());
      else if (row.role === "agent" && t) lines.push("Agent: " + t);
    }
    if (!lines.length) return "";
    let body = lines.join("\n");
    if (body.length > HISTORY_MAX) body = body.slice(-HISTORY_MAX);
    return "This chat was restored and the earlier agent session could not be loaded. Prior conversation:\n" + body;
  }

  // An incoming cross-pane handoff (lib/handoff.js) that no prompt has carried yet.
  function pendingHandoffIn(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.role === "user") return "";
      if (row.role === "system" && row.kind === "handoff-in" && !row.consumed) return row.instruction || "";
    }
    return "";
  }

  function firstPromptPrefix(transcript, harnessId, chatId) {
    return handoffPrompt(transcript, { harnessId, chatId }) || historyPrefix(transcript.filter((r) => !(r.role === "system" && r.kind === "handoff-in")));
  }

  function dispose(s) {
    s.disposed = true;
    cancelPermissions(s);
    if (s.turn) s.turn.abort();
    if (s.client) s.client.stop();
  }

  async function start(chatId) {
    if (closed) throw new Error("JAgents is stopping.");
    const existing = sessions.get(chatId);
    if (existing && !existing.disposed) {
      if (existing.startPromise) return existing.startPromise;
      if (existing.status === "ready" || existing.status === "busy") return snapshot(chatId);
      dispose(existing);
    }
    const chat = chatRecord(chatId);
    const agent = acpAgent(chat.harnessId);
    if (!agent) throw new Error("Unknown agent: " + chat.harnessId);
    const s = {
      chatId, title: chat.title, harnessId: chat.harnessId, status: "starting", error: "", agentName: agent.name,
      transcript: (existing && existing.transcript) || chat.transcript.slice(), sessionId: "", client: null, turn: null,
      prefix: "", contextSent: false, disposed: false, replaying: false, turnStart: 0,
      permissions: [], commands: existing && existing.commands, usage: existing && existing.usage,
    };
    withIds(s.transcript);
    for (const row of s.transcript) if (row.role === "tool" && (row.status === "pending" || row.status === "in_progress")) row.status = "cancelled";
    sessions.set(chatId, s);
    emitState(chatId, true);
    s.startPromise = (async () => {
      let stderr = "";
      try {
        const spec = acpSpawnSpec(chat.harnessId);
        const cwd = chat.cwd || defaultCwd();
        const mcpServers = mcpServersFor(chatId);
        if (chat.harnessId === "devin") writeDevinMcpConfig(cwd, mcpServers);
        const client = makeClient(chat.harnessId, {
          harnessId: chat.harnessId, dataRoot, cwd, mcpServers, disallowedTools: disallowedFor ? disallowedFor(chatId) : [],
          onUpdate: (p) => onUpdate(s, p),
          onPermission: (params) => askPermission(s, params),
          permissionMode: permMode(chatId, chat),
        });
        s.client = client;
        const choice = authChoice(chat.harnessId);
        const env = Object.assign({ JAGENTS_PANE_ID: chatId }, spec.env, choice ? choice.env : {});
        client.start({ command: spec.command, args: spec.args, cwd, env });
        watchClient(client, (t) => (stderr = (stderr + t).slice(-2000)), (code, signal) => {
          if (s.disposed || sessions.get(chatId) !== s) return;
          // A failed start already stopped the agent; keep its error (sign-in hints) on screen.
          if (s.status === "error" && s.error) {
            s.client = null;
            return emitState(chatId, true);
          }
          const midTurn = s.status === "busy";
          s.status = midTurn || (code && code !== 0) ? "error" : "idle";
          s.error = s.status === "error" ? "Agent exited" + (signal ? ": " + signal : " with code " + code) + (stderr ? ": " + stderr.trim().split("\n").pop() : "") : "";
          s.client = null;
          emitState(chatId, true);
          notifyTurn(chatId);
        });
        const init = await client.initialize();
        if (s.disposed) throw new Error("Stopped.");
        if (choice && (client.authMethods || []).some((m) => m.id === choice.methodId)) {
          try {
            await client.authenticate(choice.methodId, choice.meta);
          } catch (error) {
            const failed = new Error("Sign-in failed: " + String(error.message || error));
            failed.code = -32000;
            throw failed;
          }
        }
        s.agentName = (init && init.agentInfo && (init.agentInfo.title || init.agentInfo.name)) || agent.name;
        saveCaps(chat.harnessId, client);
        const canLoad = Boolean(init && init.agentCapabilities && init.agentCapabilities.loadSession);
        const params = { cwd, mcpServers };
        let resumed = false;
        if (chat.acpSessionId && canLoad) {
          s.replaying = true;
          try {
            await client.loadSession(chat.acpSessionId, Object.assign({}, params, { sessionId: chat.acpSessionId }));
            s.sessionId = chat.acpSessionId;
            resumed = true;
          } catch {
            /* expired on the agent side; start a fresh session */
          } finally {
            s.replaying = false;
          }
        }
        if (!resumed) {
          const created = await client.newSession(params);
          s.sessionId = created.sessionId || created.session_id;
          s.prefix = firstPromptPrefix(s.transcript, s.harnessId, chatId);
        } else {
          s.contextSent = true;
        }
        s.status = "ready";
        saveModelCatalog(s.harnessId, client.models);
        await applyModelPref(s.harnessId, client, s.sessionId);
        await applyEffortPref(s);
        persist(s, true);
        return snapshot(chatId);
      } catch (error) {
        const auth = error.code === -32000 || /auth|sign.?in|log.?in/i.test(String(error.message || ""));
        const methods = auth && s.client && Array.isArray(s.client.authMethods) ? s.client.authMethods.map(authMethodView) : [];
        s.status = "error";
        s.authMethods = methods;
        s.error = methods.length
          ? (/^Sign-in failed/.test(String(error.message)) ? String(error.message) + " " : "") + agent.name + " needs you to sign in."
          : String(error.message || error) + (stderr && !auth ? " " + stderr.trim().split("\n").pop() : "") + (auth ? " Sign in to " + agent.name + " first (" + agent.install + ")" : "");
        if (s.client) s.client.stop();
        s.client = null;
        throw new Error(s.error);
      } finally {
        s.startPromise = null;
        emitState(chatId, true);
        notifyTurn(chatId);
      }
    })();
    return s.startPromise;
  }

  // Signs a chat's agent in with one of the methods it offered, then sends the
  // message that was waiting on it.
  async function authenticate(chatId, methodId, secret) {
    const chat = chatRecord(chatId);
    const s = sessions.get(chatId);
    const offered = (s && s.authMethods) || [];
    const method = offered.find((m) => m.id === methodId);
    if (!method) throw new Error("That sign-in method is not offered.");
    if (method.terminal) throw new Error(method.name + " signs in from a terminal: " + (method.description || "run the agent's login command") + ".");
    const key = String(secret || "").trim();
    if (method.needsKey && !key) throw new Error("Enter the " + method.keyLabel + " first.");
    const isEnv = method.needsKey && /^[A-Z][A-Z0-9_]*$/.test(method.keyLabel);
    authChoices.set(chat.harnessId, {
      methodId,
      meta: method.needsKey && !isEnv ? { "api-key": { apiKey: key } } : null,
      env: isEnv ? { [method.keyLabel]: key } : {},
    });
    if (!method.needsKey) db.setSetting("agent-auth:" + chat.harnessId, methodId);
    if (s) {
      dispose(s);
      sessions.delete(chatId);
    }
    try {
      await start(chatId);
    } catch (error) {
      authChoices.delete(chat.harnessId);
      db.setSetting("agent-auth:" + chat.harnessId, "");
      throw error;
    }
    // The message that hit the sign-in wall is the last row; send it now.
    const live = sessions.get(chatId);
    const last = live && live.transcript[live.transcript.length - 1];
    if (last && last.role === "user" && !last.from) {
      const saved = { text: last.text, attachments: last.attachments };
      live.transcript.pop();
      persist(live, true);
      prompt(chatId, saved).catch(() => {});
    }
    return snapshot(chatId);
  }

  function titleFrom(text, attachments) {
    const t = String(text).replace(/\s+/g, " ").trim().slice(0, 60);
    if (t) return t;
    if (attachments && attachments.length) return attachments.length === 1 ? attachments[0].name : attachments.length + " files";
    return "New thread";
  }

  async function prompt(chatId, textIn, meta) {
    if (closed) throw new Error("JAgents is stopping.");
    const arg = promptArg(textIn, meta);
    const userText = arg.text.trim();
    const from = arg.from;
    if (!userText && !arg.attachments.length) throw new Error("Type a message or attach a file first.");
    let s = sessions.get(chatId);
    // Mid-turn messages wait in the queue (shown as cards) and go out in order.
    if (s && !s.disposed && (s.status === "busy" || (s.startPromise && s.status === "starting"))) {
      const q = queues.get(chatId) || [];
      q.push({ id: rowId(), text: userText, attachments: arg.attachments, from });
      queues.set(chatId, q);
      emitState(chatId, true);
      return snapshot(chatId);
    }
    const attachments = saveAttachments(dataRoot, chatId, arg.attachments);
    const userRow = { id: rowId(), role: "user", text: userText };
    if (attachments.length) userRow.attachments = attachments;
    if (from) userRow.from = from;
    if (!s || s.disposed || s.status !== "ready") {
      const chat = chatRecord(chatId);
      const rows = (s && !s.disposed && s.transcript) || chat.transcript.slice();
      rows.push(Object.assign({ at: Date.now() }, userRow));
      if (chat.title === "New thread") chat.title = titleFrom(userText, attachments);
      db.saveChat(Object.assign(chat, { transcript: rows }));
      if (s && !s.disposed) s.transcript = rows;
      await start(chatId);
      s = sessions.get(chatId);
      s.title = db.getChat(chatId).title;
    } else {
      push(s, userRow);
      const chat = db.getChat(chatId);
      if (chat && chat.title === "New thread") s.title = titleFrom(userText, attachments);
    }
    // The cross-pane handoff note rides on the first prompt after it landed.
    let handoffIn = "";
    for (let i = s.transcript.length - 2; i >= 0; i--) {
      const row = s.transcript[i];
      if (row.role === "user") break;
      if (row.role === "system" && row.kind === "handoff-in" && !row.consumed) {
        handoffIn = row.instruction || "";
        row.consumed = true;
        break;
      }
    }
    const parts = [];
    if (!s.contextSent) parts.push(contextFor(chatId));
    if (s.prefix) parts.push(s.prefix);
    if (handoffIn) parts.push(handoffIn);
    const said = from ? "Message from " + from + " (another agent, via JAgents):\n" + userText : userText;
    parts.push(parts.length ? (from ? said : "User request:\n" + userText) : said);
    // The client turns attachments into the blocks this agent can take.
    const promptInput = attachments.length ? { text: parts.join("\n\n"), attachments } : parts.join("\n\n");
    s.contextSent = true;
    s.prefix = "";
    s.status = "busy";
    s.turnStart = s.transcript.length;
    s.turn = new AbortController();
    s.lastUserRow = s.transcript.length - 1;
    emitState(chatId, true);
    try {
      const result = await s.client.promptWithRecovery(promptInput, s.sessionId, { signal: s.turn.signal });
      if (result && result.stopReason === "cancelled") push(s, { role: "system", text: "Stopped." });
      else if (result && result.stopReason && result.stopReason !== "end_turn") push(s, { role: "system", text: "Turn ended: " + result.stopReason + "." });
      s.status = "ready";
    } catch (error) {
      s.status = s.client && s.client.started ? "ready" : "error";
      s.error = s.status === "error" ? String(error.message || error) : "";
      push(s, { role: "error", text: String(error.message || error) });
    } finally {
      s.turn = null;
      cancelPermissions(s);
      // Tool calls still open when the turn ended (a stop, a crash) did not finish.
      for (let i = s.turnStart; i < s.transcript.length; i++) {
        const r = s.transcript[i];
        if (r.role === "tool" && (r.status === "pending" || r.status === "in_progress")) r.status = "cancelled";
      }
      persist(s, true);
      emitState(chatId, true);
      notifyTurn(chatId);
      setTimeout(() => drainQueue(chatId), 0);
      if (!s.disposed) emit("acp-attention", { chatId, kind: s.status === "error" ? "error" : "done", title: s.title || "", agentName: s.agentName });
    }
    return snapshot(chatId);
  }

  // Sends the last user message again (the Retry button on an error row).
  function retry(chatId) {
    const s = sessions.get(chatId);
    const rows = (s && !s.disposed ? s.transcript : chatRecord(chatId).transcript) || [];
    const last = lastRow(rows, (r) => r.role === "user");
    if (!last) throw new Error("There is no message to send again.");
    const attachments = (last.attachments || []).filter((a) => a && a.path).map((a) => ({ name: a.name, mimeType: a.mimeType, path: a.path }));
    return prompt(chatId, { text: last.text || "", attachments }, { from: last.from || "" });
  }

  function editQueued(chatId, queueId, text) {
    const q = queues.get(chatId) || [];
    const item = q.find((x) => x.id === queueId);
    if (!item) throw new Error("That message was already sent.");
    if (item.from) throw new Error("Messages from other agents cannot be edited.");
    const t = String(text || "").trim();
    if (!t && !(item.attachments || []).length) return removeQueued(chatId, queueId);
    item.text = t;
    emitState(chatId, true);
    return snapshot(chatId);
  }

  function removeQueued(chatId, queueId) {
    const q = (queues.get(chatId) || []).filter((x) => x.id !== queueId);
    if (q.length) queues.set(chatId, q);
    else queues.delete(chatId);
    emitState(chatId, true);
    return snapshot(chatId);
  }

  // Messages from other agents that land while this one is mid-turn wait here
  // and go out, in order, when the turn ends.
  function deliver(chatId, text, from) {
    const s = sessions.get(chatId);
    const busy = s && !s.disposed && (s.status === "busy" || s.status === "starting");
    if (busy) {
      const q = queues.get(chatId) || [];
      q.push({ id: rowId(), text, from });
      queues.set(chatId, q);
      emitState(chatId, true);
      return { delivered: false, queued: q.length };
    }
    prompt(chatId, text, { from }).catch(() => {});
    return { delivered: true, queued: 0 };
  }

  function drainQueue(chatId) {
    if (closed) return;
    const q = queues.get(chatId);
    if (!q || !q.length) return;
    const s = sessions.get(chatId);
    if (s && (s.status === "busy" || s.status === "starting")) return;
    const next = q.shift();
    if (!q.length) queues.delete(chatId);
    prompt(chatId, { text: next.text, attachments: next.attachments || [] }, { from: next.from }).catch(() => {});
  }

  function isBusy(chatId) {
    const s = sessions.get(chatId);
    return Boolean(s && !s.disposed && (s.status === "busy" || s.status === "starting" || (queues.get(chatId) || []).length));
  }

  // Resolves when the chat has no turn running and nothing queued, or after timeoutMs.
  function waitTurn(chatId, timeoutMs) {
    return new Promise((resolve) => {
      if (!isBusy(chatId)) return resolve("idle");
      let set = turnWaiters.get(chatId);
      if (!set) turnWaiters.set(chatId, (set = new Set()));
      const done = (why) => {
        clearTimeout(timer);
        set.delete(check);
        resolve(why);
      };
      const check = () => setTimeout(() => !isBusy(chatId) && done("idle"), 20);
      const timer = setTimeout(() => done("timeout"), timeoutMs || 50000);
      set.add(check);
    });
  }

  // The agent's answer to the latest prompt: agent rows after the last user row.
  function lastReply(chatId) {
    const snap = snapshot(chatId);
    if (!snap) return "";
    const rows = snap.transcript;
    let i = rows.length - 1;
    while (i >= 0 && rows[i].role !== "user") i--;
    const parts = rows.slice(i + 1).filter((r) => r.role === "agent" || r.role === "error").map((r) => (r.role === "error" ? "[error] " : "") + r.text);
    return parts.join("\n\n").trim();
  }

  function cancel(chatId) {
    const s = sessions.get(chatId);
    queues.delete(chatId);
    if (s) cancelPermissions(s);
    if (s && s.turn) s.turn.abort();
    emitState(chatId, true);
    return { ok: true };
  }

  async function setModel(chatId, modelId) {
    const s = sessions.get(chatId);
    // No live session yet (or still starting): keep the choice; start() applies
    // it through applyModelPref once the agent has a session.
    if (!s || s.disposed || !s.client || !s.sessionId || s.status === "starting") {
      await setModelPref(chatRecord(chatId).harnessId, modelId);
      emitState(chatId, true);
      return snapshot(chatId);
    }
    await s.client.setModel(String(modelId), s.sessionId);
    db.setSetting("agent-model:" + s.harnessId, String(modelId));
    saveModelCatalog(s.harnessId, s.client.models);
    await applyEffortPref(s);
    emitState(chatId, true);
    return snapshot(chatId);
  }

  function modelInfo(harnessId) {
    const id = String(harnessId || "");
    return Object.assign({ preferred: modelPref(id) }, probeState(id));
  }

  async function setModelPref(harnessId, modelId) {
    const id = String(harnessId || "");
    const mid = String(modelId || "");
    db.setSetting("agent-model:" + id, mid);
    for (const s of sessions.values()) {
      if (s.disposed || s.harnessId !== id || !s.client || s.client.models.currentModelId === mid) continue;
      try {
        await s.client.setModel(mid, s.sessionId);
        await applyEffortPref(s);
        emitState(s.chatId);
      } catch {
        /* next start applies the pref */
      }
    }
    return modelInfo(id);
  }

  function createChat(input) {
    const src = input || {};
    const id = src.id || randomUUID();
    db.createChat({ id, title: src.title || "New thread", harnessId: src.harnessId || "devin", cwd: src.cwd || defaultCwd(), parentId: src.parentId || "", handle: src.handle || "", transcript: src.transcript || [] });
    emit("chats-changed", {});
    return snapshot(id);
  }

  // A cross-pane handoff landed on this chat: show it as a marker and carry the
  // instruction on the next prompt.
  function receiveHandoff(chatId, row) {
    const s = sessions.get(chatId);
    const full = Object.assign({ role: "system", kind: "handoff-in", at: Date.now() }, row);
    if (s && !s.disposed) return push(s, full);
    const chat = chatRecord(chatId);
    chat.transcript.push(full);
    db.saveChat(chat);
    emitState(chatId, true);
  }

  // In-thread agent switch (Plugin App's handoff).
  function handoff(chatId, harnessId) {
    const id = String(chatId || "");
    const next = String(harnessId || "");
    const agent = acpAgent(next);
    if (!agent) throw new Error("Unknown agent: " + next);
    const chat = chatRecord(id);
    const from = String(chat.harnessId || "");
    if (from === next) return snapshot(id);
    const s = sessions.get(id);
    if (s && (s.status === "busy" || s.status === "starting")) throw new Error("Wait for the current turn to finish before switching agents.");
    const live = s && Array.isArray(s.transcript) ? s.transcript.map((row) => Object.assign({}, row)) : null;
    if (s) {
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      dispose(s);
      sessions.delete(id);
    }
    const fromAgent = acpAgent(from);
    db.switchChatHarness(id, { harnessId: next, fromName: (fromAgent && fromAgent.name) || from, toName: agent.name, liveTranscript: live });
    emitState(id, true);
    emit("chats-changed", {});
    return snapshot(id);
  }

  function stopChat(chatId) {
    const s = sessions.get(chatId);
    if (s) {
      persist(s, true);
      dispose(s);
      sessions.delete(chatId);
    }
    queues.delete(chatId);
    emitState(chatId, true);
    notifyTurn(chatId);
  }

  function deleteChat(chatId) {
    stopChat(chatId);
    cancelWaits(chatId, "all");
    clearTimeout(saveTimers.get(chatId));
    const ok = db.deleteChat(chatId);
    // The chat's attached files go with it.
    if (ok) require("node:fs").rmSync(attachmentsDir(dataRoot, chatId), { recursive: true, force: true });
    emit("chats-changed", {});
    return ok;
  }

  // save: false when another JAgents has the data now; nothing more is written.
  function stopAll(opts) {
    // Nothing starts or fires after the app stops: JAgents inside JWorkspace
    // reloads in the same process and closes the database. Queued messages
    // are dropped, or a turn ended here would send the next one and start its
    // agent again in a stopped app. Waiting hub calls end now.
    closed = true;
    saveAfterStop = !(opts && opts.save === false);
    queues.clear();
    for (const s of sessions.values()) {
      persist(s, true);
      dispose(s);
    }
    sessions.clear();
    for (const p of probes.values()) if (p.client) p.client.stop();
    probes.clear();
    for (const t of emitTimers.values()) clearTimeout(t);
    emitTimers.clear();
    for (const t of saveTimers.values()) clearTimeout(t);
    saveTimers.clear();
    for (const chatId of Array.from(turnWaiters.keys())) notifyTurn(chatId);
  }

  function liveIds() {
    return Array.from(sessions.values()).filter((s) => !s.disposed).map((s) => s.chatId);
  }

  function childPid(chatId) {
    const s = sessions.get(chatId);
    return s && s.client && s.client.child ? s.client.child.pid : 0;
  }

  return {
    listAgents: listAcpAgents,
    listChats: () => db.listChats(),
    snapshot,
    createChat,
    handoff,
    receiveHandoff,
    deleteChat,
    stopChat,
    start,
    prompt,
    deliver,
    waitTurn,
    lastReply,
    isBusy,
    cancel,
    setModel,
    setEffort,
    setPermissionMode,
    answerPermission,
    askForSubagent,
    cancelSubagentPermissions,
    retry,
    editQueued,
    removeQueued,
    modelInfo,
    setModelPref,
    probe,
    authenticate,
    stopAll,
    liveIds,
    childPid,
  };
}

module.exports = { createAcpHost, writeDevinMcpConfig };
