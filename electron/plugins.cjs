"use strict";

// JAgents plugins: folders under <dataRoot>/plugins/<id> that change the app.
//   plugin.json  name, description, version, plus what agents get:
//                mcpServers (outside MCP servers every agent gets by default)
//                disableTools (MCP or built-in tools agents may not use)
//   renderer.js  ES module run in the window: export function activate(jagents) {}
//   style.css    injected into the window
//   main.cjs     CommonJS in the main process (full Node and Electron); it can
//                run MCP servers inside JAgents that every agent gets.
// Agents write plugins through the jagents MCP tools (hub.cjs), the user through
// the Plugins panel or any editor; every change reloads live. On/off state, who
// changed a plugin last, and load errors live in jagents.db; each change first
// snapshots the old files under plugins/.history so it can be undone. Plugins
// shipped with the app (<app>/plugins) are copied in once on first run.
//
// Built-in features (<app>/builtin/<id>: the browser, subagents) use the same
// files and API but are part of JAgents: always on (safe mode too), not listed
// with the user's plugins, and not editable or removable. Their data stays in
// plugin-data/<id>.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SERVER_RE = /^[a-zA-Z0-9_-]{1,40}$/;
const RESERVED_SERVERS = ["jagents", "relay"];
const FILE_MAX = 512 * 1024;
const HISTORY_KEEP = 20;
// Former plugins that are built into JAgents now (the chat look, attachments,
// settling threads, usage, the browser and subagents).
const RETIRED = ["jsystems-new-ui", "image-input", "settle-threads", "usage-meter", "browser", "subagents"];

// Copy then delete: renaming a folder that fs.watch is watching fails on Windows.
function moveDir(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true });
  fs.rmSync(from, { recursive: true, force: true });
}

const DOCS = `# JAgents plugins

A plugin is a folder that changes the JAgents app: its UI, what the agents can
do, and new features (a built-in browser is one). Agents create and edit
plugins with the jagents MCP tools (plugin_docs, list_plugins, read_plugin,
write_plugin, set_plugin_enabled, undo_plugin, delete_plugin). The user sees
and controls them in the Plugins panel (bottom of the sidebar). Every
change reloads live and keeps the previous version so it can be undone.

## Files

- plugin.json
    {
      "name": "GitHub tools",
      "description": "One sentence for the Plugins panel",
      "version": "1.0.0",
      "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {} } },
      "disableTools": ["jagents.spawn_subagent", "github.delete_repository", "WebFetch"]
    }
  mcpServers: outside MCP servers that every agent JAgents starts gets by default
    (Claude Code and Codex terminals, Claude Code chats, ACP chats).
  disableTools: tools agents may not use. "server.tool" blocks one MCP tool
    (jagents.* tools are removed from the jagents server itself); a bare name like
    "WebFetch" blocks a Claude Code built-in tool.
  Agents pick up MCP changes when they start, so running terminals need Restart.
- renderer.js: ES module in the JAgents window.
    export function activate(jagents) { ...; return () => { /* optional cleanup */ } }
- style.css: CSS for the window. JAgents's colors are CSS variables that switch with
    the theme: --canvas (page), --surface (panels), --well (inputs, hover), --line,
    --ink (text), --muted, --accent, --accent-ink (text on accent), --accent-soft,
    --ok, --warn, --danger; also --font, --mono and --radius. Use them so the
    plugin fits dark and light themes.
- main.cjs: CommonJS in the Electron main process, with full Node.js and Electron.
    exports.activate = (ctx) => { ...; return () => {} }
- Any other files (images, data). Renderer code can load them by relative URL.

## Renderer API (the jagents argument of activate)

Everything you add is removed automatically when the plugin reloads or is turned off.
Timers, animation frames and observers you start are not: stop them in the cleanup
function and have callbacks check a flag it sets. A callback that keeps running after
cleanup can fight the next copy of the plugin and freeze the window.

- jagents.topbar.button({ icon, label, title, onClick }): an icon button in the dock at
    the bottom of the sidebar (JAgents has no top bar since v0.6; the label becomes the
    tooltip). icon is an icon name (plus, chat, terminal, grid, hub, sun, moon, restart,
    handoff, folder, search, close, puzzle, globe, back, next, external, code, undo, gear)
    or an <svg> string.
- jagents.sidebar.section({ title, render(el) }): a section in the Code mode sidebar,
    under Projects. jagents.sidebar.refresh() renders again.
- A page of your own: add a tab to the sidebar's mode tabs (.mode-seg, a button with
    role="tab" and data-mode="<your id>") and a view in main.main. JAgents marks the
    tab .on when it is picked; show your view while it is. The top 38px of the window
    is the title bar: JAgents keeps that band free above plugin pages.
- jagents.panes.register(kind, { title, icon, mount(el, pane) }): a new tab type for
    Code mode, listed in the new tab picker. mount may return a cleanup function.
    pane.id, pane.state (saved per pane), pane.setState(obj), pane.setTitle(text),
    pane.visible() (false while the pane is parked or covered by a menu).
- jagents.panes.open(kind, { title, state }): open a pane of a registered kind.
- jagents.css(text): add CSS.
- jagents.on(type, fn): app events: pty-data {id, data}, pty-exit, acp-state,
    panes-changed, chats-changed, hub-activity, theme, overlay {open} (a menu or
    dialog opened or closed over the panes), layout (panes moved or resized).
- jagents.toast(text), jagents.modal(html, { width }) returns { el, close }.
- jagents.icon(name, size), jagents.esc(text) (HTML-escape).
- jagents.storage.get(key, fallback), jagents.storage.set(key, value): saved in jagents.db.
- jagents.invoke(channel, payload): call ctx.handle(channel) in this plugin's main.cjs.
- jagents.onMessage(channel, fn): messages from ctx.send in main.cjs.
- jagents.app: the JAgents bridge (panes, chats, agents, pty, hub), e.g.
    jagents.app.panes.addTerminal({ provider: "claude" }), jagents.app.pty.write(id, text).
- jagents.store: live state (store.panes, store.chats, store.hubAgents, store.info).
- jagents.dispose(fn): run fn when the plugin unloads.

The window blocks remote scripts, frames and network requests. Show web pages
with an Electron WebContentsView from main.cjs (see JAgents' built-in browser, builtin/browser in the app)
and do network work in main.cjs.

## Main API (the ctx argument of activate in main.cjs)

- ctx.mcp.server(name, { description }): an MCP server that runs inside JAgents.
    Every agent JAgents starts gets it by default, as the MCP server "name".
    Returns { tool({ name, description, inputSchema, handler(args, caller) }) }.
    handler returns any JSON value or a promise; caller is the agent ({handle, kind, ...}).
- ctx.handle(channel, fn(payload)): answer jagents.invoke from the renderer.
- ctx.send(channel, payload): reach jagents.onMessage in the renderer.
- ctx.window(): the JAgents BrowserWindow. Inside JWorkspace, a stand-in with
  contentView (views added there use the page's coordinates), webContents,
  isDestroyed, isFocused, focus and on("closed"). require("electron") works too.
- ctx.hub(toolName, args): call a jagents tool as the app (list_agents, send_message, ...).
- ctx.notify(text): a toast. ctx.log(...): JAgents's log.
- ctx.dir: this plugin's folder. ctx.dataDir: a folder for its own files.
- ctx.hubDir: the folder with the hub's files (hub.json, jagents-mcp.cjs,
  jagents-plugin-mcp.cjs), usually ~/.jagents.
- ctx.dispose(fn): run fn when the plugin unloads.
- ctx.permissions.ask({ parent, handle, agentName, harnessId, params }): an agent this
    plugin runs for another agent (parent: that agent's handle) asks to use a tool.
    params is ACP session/request_permission params. Resolves to the ACP outcome,
    decided by the parent thread's permission mode or the user's pick on a card
    that names handle. ctx.permissions.cancel(handle) drops that agent's cards.

## Example: a notes pane

renderer.js:
    export function activate(jagents) {
      jagents.panes.register("notes", {
        title: "Notes",
        icon: "chat",
        mount(el, pane) {
          el.innerHTML = '<textarea class="notes-box"></textarea>';
          const box = el.querySelector("textarea");
          box.value = pane.state.text || "";
          box.oninput = () => pane.setState({ text: box.value });
        },
      });
    }
style.css:
    .notes-box { width: 100%; height: 100%; border: 0; resize: none; padding: 12px;
      background: var(--surface); color: var(--ink); font: 14px/1.5 var(--font); }

## Example: an MCP server inside JAgents (main.cjs)

    exports.activate = (ctx) => {
      const srv = ctx.mcp.server("clock", { description: "Time helpers" });
      srv.tool({ name: "now", description: "Current time", inputSchema: { type: "object", properties: {} },
                 handler: () => ({ iso: new Date().toISOString() }) });
    };

If a plugin breaks the window, Ctrl+Shift+F12 turns every plugin off (safe mode)
and reloads; the Plugins panel turns them back on.
`;

// hubDir: the hub's folder (ctx.hubDir); ~/.jagents or JAGENTS_HOME when not given.
function createPluginManager({ dataRoot, hubDir, db, emit, notify, log, bundledDir, builtinDir, getWindow, permissions }) {
  const dir = path.join(dataRoot, "plugins");
  const historyDir = path.join(dir, ".history");
  const trashDir = path.join(dir, ".trash");
  const mains = new Map(); // id -> {dispose: [fn], handlers: Map, servers: Map}
  const errors = new Map(); // id -> {main, renderer, mcp}
  const reportWaiters = new Map(); // id -> [fn]
  const suppress = new Map(); // id -> ms until which watcher events are ours
  let hubCall = null;
  let watcher = null;
  const watchTimers = new Map(); // id -> reload waiting for edits to settle

  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, "README.md"), DOCS);
  } catch {
    /* read-only data folder; plugin_docs still works */
  }

  function state() {
    return db.getSetting("plugins.state", {}) || {};
  }

  function saveState(next) {
    db.setSetting("plugins.state", next);
  }

  function safeMode() {
    return process.env.JAGENTS_SAFE_MODE === "1" || Boolean(db.getSetting("plugins.safe", false));
  }

  function checkId(id) {
    const v = String(id || "").trim();
    if (!ID_RE.test(v)) throw new Error("Plugin ids are 1-40 lowercase letters, digits and dashes, starting with a letter or digit: " + JSON.stringify(id));
    return v;
  }

  function pluginDir(id) {
    return path.join(dir, checkId(id));
  }

  const BUILTIN = (() => {
    try {
      return fs.readdirSync(builtinDir, { withFileTypes: true }).filter((e) => e.isDirectory() && ID_RE.test(e.name) && fs.existsSync(path.join(builtinDir, e.name, "plugin.json"))).map((e) => e.name).sort();
    } catch {
      return [];
    }
  })();
  const isBuiltin = (id) => BUILTIN.includes(id);

  // Where a plugin's files are: the app for built-ins, else the plugins folder.
  function rootOf(id) {
    return isBuiltin(id) ? path.join(builtinDir, id) : pluginDir(id);
  }

  function notBuiltin(id) {
    if (isBuiltin(id)) throw new Error(id + " is built into JAgents and cannot be changed, turned off or removed. Pick another plugin id.");
    return id;
  }

  function insidePlugin(id, rel) {
    const root = pluginDir(id);
    const abs = path.resolve(root, String(rel || ""));
    if (!abs.startsWith(root + path.sep)) throw new Error("File path leaves the plugin folder: " + rel);
    return abs;
  }

  function readManifest(id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(rootOf(id), "plugin.json"), "utf8"));
    } catch {
      return {};
    }
  }

  function walk(root, base) {
    const out = [];
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const rel = base ? base + "/" + e.name : e.name;
      if (e.isDirectory()) out.push(...walk(path.join(root, e.name), rel));
      else out.push(rel);
    }
    return out;
  }

  function stamp(id) {
    let t = 0;
    for (const f of walk(rootOf(id), "")) {
      try {
        t = Math.max(t, fs.statSync(path.join(rootOf(id), f)).mtimeMs);
      } catch {
        /* removed meanwhile */
      }
    }
    return Math.round(t);
  }

  function ids() {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && ID_RE.test(e.name) && !isBuiltin(e.name)).map((e) => e.name).sort();
    } catch {
      return [];
    }
  }

  function historyFor(id) {
    try {
      return fs.readdirSync(path.join(historyDir, id)).sort();
    } catch {
      return [];
    }
  }

  function isOn(id) {
    if (isBuiltin(id)) return true;
    return !safeMode() && (state()[id] || {}).enabled !== false;
  }

  function info(id) {
    const m = readManifest(id);
    const st = state()[id] || {};
    const files = walk(rootOf(id), "");
    const err = errors.get(id) || {};
    const entry = mains.get(id);
    return {
      id,
      name: String(m.name || id),
      description: String(m.description || ""),
      version: String(m.version || ""),
      enabled: isBuiltin(id) || st.enabled !== false,
      builtin: isBuiltin(id),
      // Shipped in the app's plugins folder, and flagged as a trial by its manifest.
      included: Boolean(bundledDir && fs.existsSync(path.join(bundledDir, id, "plugin.json"))),
      experimental: m.experimental === true,
      author: st.author || "",
      updatedAt: st.updatedAt || 0,
      files,
      hasRenderer: files.includes("renderer.js"),
      hasCss: files.includes("style.css"),
      hasMain: files.includes("main.cjs"),
      mcpServers: Object.keys(m.mcpServers && typeof m.mcpServers === "object" ? m.mcpServers : {}),
      appServers: entry ? Array.from(entry.servers.values()).map((s) => ({ name: s.name, tools: Array.from(s.tools.keys()) })) : [],
      disableTools: Array.isArray(m.disableTools) ? m.disableTools.map(String) : [],
      errors: { main: err.main || "", renderer: err.renderer || "", mcp: err.mcp || "" },
      undoable: historyFor(id).length,
      stamp: stamp(id),
    };
  }

  function list() {
    const all = ids().map(info);
    return { safeMode: safeMode(), dir, plugins: all.filter((p) => p.included).concat(all.filter((p) => !p.included)), builtins: BUILTIN.map(info) };
  }

  function read(id) {
    const root = rootOf(checkId(id));
    if (!fs.existsSync(root)) throw new Error("No plugin " + id + ". Call list_plugins.");
    const files = {};
    for (const f of walk(root, "")) {
      const abs = path.join(root, f);
      const size = fs.statSync(abs).size;
      files[f] = size > FILE_MAX ? "(" + size + " bytes, too large to show)" : fs.readFileSync(abs, "utf8");
    }
    return Object.assign(info(id), { content: files });
  }

  function snapshot(id) {
    const root = pluginDir(id);
    if (!fs.existsSync(root)) return;
    const dest = path.join(historyDir, id, String(Date.now()));
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(root, dest, { recursive: true });
    const all = historyFor(id);
    for (const old of all.slice(0, Math.max(0, all.length - HISTORY_KEEP))) fs.rmSync(path.join(historyDir, id, old), { recursive: true, force: true });
  }

  function touch(id, author, patch) {
    const st = state();
    st[id] = Object.assign({ enabled: true }, st[id], { author: author || "you", updatedAt: Date.now() }, patch || {});
    saveState(st);
  }

  function setError(id, part, error) {
    const err = Object.assign({}, errors.get(id));
    err[part] = error ? String((error && (error.stack || error.message)) || error).split("\n").slice(0, 6).join("\n") : "";
    errors.set(id, err);
    emit("plugins-state", list());
  }

  // ---- what agents get: MCP servers and blocked tools --------------------

  // Every enabled plugin's outside servers, servers running inside JAgents, and
  // blocked tools. Server names are unique; the first plugin to claim one wins.
  function agentMcp() {
    const taken = new Set(RESERVED_SERVERS);
    const external = [];
    const inApp = [];
    const disabled = new Set();
    for (const id of BUILTIN.concat(ids())) {
      if (!isOn(id)) continue;
      const m = readManifest(id);
      const problems = [];
      const servers = m.mcpServers && typeof m.mcpServers === "object" ? m.mcpServers : {};
      for (const [name, spec] of Object.entries(servers)) {
        if (!SERVER_RE.test(name) || taken.has(name)) {
          problems.push("MCP server name " + JSON.stringify(name) + (taken.has(name) ? " is already used" : " is not allowed (letters, digits, _ and -)"));
          continue;
        }
        if (!spec || !spec.command) {
          problems.push("MCP server " + name + " has no command");
          continue;
        }
        taken.add(name);
        external.push({ name, plugin: id, command: String(spec.command), args: (spec.args || []).map(String), env: Object.assign({}, spec.env) });
      }
      const entry = mains.get(id);
      if (entry) {
        for (const srv of entry.servers.values()) {
          if (taken.has(srv.name)) {
            problems.push("MCP server name " + srv.name + " is already used");
            continue;
          }
          taken.add(srv.name);
          inApp.push({ name: srv.name, plugin: id });
        }
      }
      for (const t of Array.isArray(m.disableTools) ? m.disableTools : []) if (String(t).trim()) disabled.add(String(t).trim());
      const err = errors.get(id) || {};
      const text = problems.join("; ");
      if ((err.mcp || "") !== text) errors.set(id, Object.assign({}, err, { mcp: text }));
    }
    return { external, inApp, disabled: Array.from(disabled) };
  }

  function appServer(name) {
    for (const [id, entry] of mains) if (isOn(id) && entry.servers.has(name)) return entry.servers.get(name);
    return null;
  }

  function appServerTools(name) {
    const srv = appServer(name);
    if (!srv) throw new Error("No MCP server " + name + " is running in JAgents. Its plugin may be off.");
    const off = new Set(agentMcp().disabled);
    return {
      description: srv.description,
      tools: Array.from(srv.tools.values())
        .filter((t) => !off.has(name + "." + t.name))
        .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    };
  }

  async function callAppServer(name, tool, args, caller) {
    const srv = appServer(name);
    if (!srv) throw new Error("No MCP server " + name + " is running in JAgents. Its plugin may be off.");
    const t = srv.tools.get(String(tool));
    if (!t) throw new Error("MCP server " + name + " has no tool " + tool + ".");
    if (agentMcp().disabled.includes(name + "." + t.name)) throw new Error(name + "." + t.name + " is turned off by a JAgents plugin.");
    return t.handler(args || {}, caller);
  }

  // ---- main-process side -------------------------------------------------

  function unloadMain(id) {
    const entry = mains.get(id);
    if (!entry) return;
    mains.delete(id);
    for (const fn of entry.dispose.reverse()) {
      try {
        fn();
      } catch (error) {
        log("plugin " + id + " cleanup failed: " + error.message);
      }
    }
    const root = rootOf(id);
    for (const key of Object.keys(require.cache)) if (key.startsWith(root + path.sep)) delete require.cache[key];
  }

  function loadMain(id) {
    unloadMain(id);
    errors.set(id, Object.assign({}, errors.get(id), { main: "" }));
    const file = path.join(rootOf(id), "main.cjs");
    if (!isOn(id) || !fs.existsSync(file)) return;
    const entry = { dispose: [], handlers: new Map(), servers: new Map() };
    mains.set(id, entry);
    const dataDir = path.join(dataRoot, "plugin-data", id);
    const ctx = {
      id,
      dir: rootOf(id),
      dataDir,
      hubDir: hubDir || (process.env.JAGENTS_HOME ? path.resolve(process.env.JAGENTS_HOME) : path.join(os.homedir(), ".jagents")),
      log: (...args) => log("[plugin " + id + "] " + args.map(String).join(" ")),
      notify: (text) => notify(String(text)),
      send: (channel, payload) => emit("plugin-message", { id, channel: String(channel), payload }),
      handle: (channel, fn) => entry.handlers.set(String(channel), fn),
      window: () => (getWindow ? getWindow() : null),
      hub: (name, args) => (hubCall ? hubCall(String(name), args || {}, null) : Promise.reject(new Error("The hub is not running."))),
      dispose: (fn) => entry.dispose.push(fn),
      permissions: {
        ask: (req) => (permissions ? permissions.ask(req) : Promise.resolve({ outcome: { outcome: "selected", optionId: "allow_once" } })),
        cancel: (handle) => (permissions ? permissions.cancel(handle) : undefined),
      },
      mcp: {
        server(name, opts) {
          const n = String(name || "");
          if (!SERVER_RE.test(n) || RESERVED_SERVERS.includes(n)) throw new Error("MCP server names are letters, digits, _ and - (and not jagents): " + JSON.stringify(name));
          const srv = { name: n, description: String((opts && opts.description) || ""), tools: new Map() };
          entry.servers.set(n, srv);
          return {
            tool(def) {
              const d = def || {};
              if (!d.name || typeof d.handler !== "function") throw new Error("tool() needs a name and a handler.");
              srv.tools.set(String(d.name), { name: String(d.name), description: String(d.description || ""), inputSchema: d.inputSchema || { type: "object", properties: {} }, handler: d.handler });
              return this;
            },
          };
        },
      },
    };
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const mod = require(file);
      const out = mod && typeof mod.activate === "function" ? mod.activate(ctx) : null;
      if (typeof out === "function") entry.dispose.push(out);
      if (mod && typeof mod.deactivate === "function") entry.dispose.push(() => mod.deactivate());
      if (out && typeof out.then === "function") out.catch((e) => setError(id, "main", e));
    } catch (error) {
      setError(id, "main", error);
    }
  }

  function invoke(id, channel, payload) {
    const entry = mains.get(id);
    const fn = entry && entry.handlers.get(String(channel));
    if (!fn) throw new Error("Plugin " + id + " has no main handler for " + channel + ".");
    return fn(payload);
  }

  // ---- reload + renderer feedback ----------------------------------------

  // The renderer loads renderer.js and style.css and reports back; write_plugin
  // waits for that so an agent sees its own errors.
  function waitReport(id, ms) {
    return new Promise((resolve) => {
      const waiters = reportWaiters.get(id) || [];
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(done);
      reportWaiters.set(id, waiters);
      timer = setTimeout(done, ms);
    });
  }

  function report(id, result) {
    const r = result || {};
    setError(id, "renderer", r.error || "");
    const waiters = reportWaiters.get(id) || [];
    reportWaiters.delete(id);
    for (const fn of waiters) fn();
  }

  async function reload(id, opts) {
    const exists = fs.existsSync(pluginDir(id));
    if (exists) loadMain(id);
    else unloadMain(id);
    agentMcp();
    const now = exists ? info(id) : null;
    const wants = Boolean(now && isOn(id) && (now.hasRenderer || now.hasCss));
    const waiting = wants && opts && opts.wait ? waitReport(id, 4000) : null;
    if (!wants) errors.set(id, Object.assign({}, errors.get(id), { renderer: "" }));
    emit("plugins-changed", { id, reason: (opts && opts.reason) || "changed" });
    emit("plugins-state", list());
    if (waiting) await waiting;
    return exists ? info(id) : null;
  }

  // ---- writes (agents, the panel, the user) ------------------------------

  async function write(idIn, input, author) {
    const id = notBuiltin(checkId(idIn));
    const src = input || {};
    const root = pluginDir(id);
    const isNew = !fs.existsSync(root);
    const files = src.files && typeof src.files === "object" ? src.files : {};
    if (isNew && !Object.keys(files).length) throw new Error("A new plugin needs files (plugin.json, renderer.js, style.css or main.cjs).");
    if (files["plugin.json"] != null) {
      try {
        JSON.parse(String(files["plugin.json"]));
      } catch (error) {
        throw new Error("plugin.json is not valid JSON: " + error.message);
      }
    }
    suppress.set(id, Date.now() + 1500);
    snapshot(id);
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const abs = insidePlugin(id, rel);
      if (content === null) {
        fs.rmSync(abs, { force: true });
        continue;
      }
      const text = String(content);
      if (Buffer.byteLength(text) > FILE_MAX) throw new Error(rel + " is over " + FILE_MAX / 1024 + " KB.");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    const manifest = readManifest(id);
    const before = JSON.stringify(manifest);
    if (src.name) manifest.name = String(src.name);
    if (src.description != null) manifest.description = String(src.description);
    if (!manifest.name) manifest.name = id;
    if (!manifest.version) manifest.version = "1.0.0";
    if (JSON.stringify(manifest) !== before || !fs.existsSync(path.join(root, "plugin.json"))) fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
    touch(id, author, isNew ? { enabled: true } : null);
    suppress.set(id, Date.now() + 1500);
    const result = await reload(id, { wait: true, reason: isNew ? "created" : "changed" });
    return Object.assign({ created: isNew }, result);
  }

  async function setEnabled(idIn, enabled, author) {
    const id = notBuiltin(checkId(idIn));
    if (!fs.existsSync(pluginDir(id))) throw new Error("No plugin " + id + ".");
    touch(id, author, { enabled: Boolean(enabled) });
    return reload(id, { wait: Boolean(enabled), reason: enabled ? "enabled" : "disabled" });
  }

  async function undo(idIn, author) {
    const id = notBuiltin(checkId(idIn));
    const all = historyFor(id);
    if (!all.length) throw new Error("Plugin " + id + " has no earlier version.");
    const last = all[all.length - 1];
    const root = pluginDir(id);
    suppress.set(id, Date.now() + 1500);
    // The version being replaced goes to the trash, not away.
    if (fs.existsSync(root)) moveDir(root, path.join(trashDir, id + "-" + Date.now()));
    fs.cpSync(path.join(historyDir, id, last), root, { recursive: true });
    fs.rmSync(path.join(historyDir, id, last), { recursive: true, force: true });
    touch(id, author);
    return reload(id, { wait: true, reason: "undone" });
  }

  async function remove(idIn, author) {
    const id = notBuiltin(checkId(idIn));
    const root = pluginDir(id);
    if (!fs.existsSync(root)) throw new Error("No plugin " + id + ".");
    suppress.set(id, Date.now() + 1500);
    unloadMain(id);
    const dest = path.join(trashDir, id + "-" + Date.now());
    moveDir(root, dest);
    const st = state();
    delete st[id];
    saveState(st);
    errors.delete(id);
    agentMcp();
    emit("plugins-changed", { id, reason: "removed" });
    emit("plugins-state", list());
    log("plugin " + id + " moved to " + dest + " by " + (author || "you"));
    return { removed: id, movedTo: dest };
  }

  // A starter the user can open in an editor.
  function scaffold() {
    let n = 1;
    while (fs.existsSync(path.join(dir, "my-plugin" + (n > 1 ? "-" + n : "")))) n++;
    const id = "my-plugin" + (n > 1 ? "-" + n : "");
    return write(
      id,
      {
        name: "My plugin",
        description: "A starting point. Edit renderer.js and style.css; JAgents reloads on save.",
        files: {
          "renderer.js":
            "// Runs in the JAgents window. README.md in the plugins folder has the full API.\n" +
            "export function activate(jagents) {\n" +
            '  jagents.topbar.button({ icon: "puzzle", title: "My plugin", onClick: () => jagents.toast("Hello from my plugin") });\n' +
            "}\n",
          "style.css": "/* Plugin styles. JAgents's colors are CSS variables like var(--accent). */\n",
        },
      },
      "you",
    );
  }

  function setSafeMode(on) {
    db.setSetting("plugins.safe", Boolean(on));
    for (const id of ids()) loadMain(id);
    agentMcp();
    emit("plugins-changed", { id: "*", reason: on ? "safe-mode" : "resumed" });
    emit("plugins-state", list());
    return list();
  }

  // Plugins shipped with JAgents are copied in once; after that they are the
  // user's to change or delete, and a deleted one does not come back.
  function seedBundled() {
    if (!bundledDir || !fs.existsSync(bundledDir)) return;
    const seeded = new Set(db.getSetting("plugins.seeded", []) || []);
    for (const e of fs.readdirSync(bundledDir, { withFileTypes: true })) {
      // An update copies over the app folder, so an old <app>/plugins/browser can linger.
      if (!e.isDirectory() || !ID_RE.test(e.name) || seeded.has(e.name) || isBuiltin(e.name)) continue;
      const dest = path.join(dir, e.name);
      if (!fs.existsSync(dest)) {
        fs.cpSync(path.join(bundledDir, e.name), dest, { recursive: true });
        touch(e.name, "JAgents", { enabled: true });
      }
      seeded.add(e.name);
    }
    db.setSetting("plugins.seeded", Array.from(seeded));
  }

  // Plugins whose features are now part of JAgents itself. A copy left in the
  // plugins folder would run on top of the built-in one, so it goes to the
  // trash (plugins/.trash), where it can still be found.
  function retireBuiltIn() {
    const st = state();
    for (const id of RETIRED) {
      const root = pluginDir(id);
      if (!fs.existsSync(root)) continue;
      try {
        moveDir(root, path.join(trashDir, id + "-" + Date.now()));
        delete st[id];
        log("plugin " + id + " is built into JAgents now; moved it to plugins/.trash");
      } catch (error) {
        log("could not retire plugin " + id + ": " + error.message);
      }
    }
    saveState(st);
  }

  // Edits made outside JAgents (an editor, an agent's own file tools) reload too.
  function watch() {
    const timers = watchTimers;
    try {
      watcher = fs.watch(dir, { recursive: true }, (_event, file) => {
        const id = String(file || "").split(/[\\/]/)[0];
        if (!ID_RE.test(id)) return;
        if ((suppress.get(id) || 0) > Date.now()) return;
        clearTimeout(timers.get(id));
        timers.set(
          id,
          setTimeout(() => {
            timers.delete(id);
            if ((suppress.get(id) || 0) > Date.now()) return;
            reload(id, { reason: "edited" }).catch(() => {});
          }, 350),
        );
      });
    } catch (error) {
      log("plugin folder watch failed: " + error.message);
    }
  }

  function start(opts) {
    hubCall = opts && opts.hubCall;
    retireBuiltIn();
    seedBundled();
    for (const id of BUILTIN.concat(ids())) loadMain(id);
    agentMcp();
    watch();
  }

  function stop() {
    if (watcher) watcher.close();
    for (const t of watchTimers.values()) clearTimeout(t);
    watchTimers.clear();
    for (const id of Array.from(mains.keys())) unloadMain(id);
  }

  // Where the window loads a plugin's renderer.js and style.css from.
  function fileRoot(id) {
    return rootOf(checkId(id));
  }

  return { dir, fileRoot, docs: DOCS, list, read, info, write, setEnabled, undo, remove, scaffold, report, invoke, agentMcp, appServerTools, callAppServer, setSafeMode, safeMode, start, stop };
}

module.exports = { createPluginManager };
