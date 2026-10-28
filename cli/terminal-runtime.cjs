"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { openDb } = require("../lib/db");
const { createPluginManager } = require("../electron/plugins.cjs");
const docs = require("./plugin-docs.cjs");

const SERVER = "jagents-terminal";
const HOME = process.env.JAGENTS_TERMINAL_HOME || path.join(os.homedir(), ".jagents", "terminal");
const DATA = process.env.JAGENTS_TERMINAL_DATA || path.join(
  process.platform === "win32" ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming") : process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"),
  "JAgents-Terminal",
);

const schema = (properties = {}, required = []) => ({ type: "object", properties, required });
const str = { type: "string" };
const bool = { type: "boolean" };
const id = { type: ["string", "number"], description: "Pane id from list_terminals." };
const TOOLS = [
  ["plugin_docs", "Read the terminal plugin API before writing a plugin.", schema()],
  ["list_plugins", "List terminal plugins, enabled state, errors and undo history.", schema()],
  ["read_plugin", "Read a terminal plugin's files.", schema({ id: str }, ["id"])],
  ["write_plugin", "Create or edit trusted terminal plugin code with live reload and undo history. Full Node.js access. Only make changes the user requested.", schema({ id: str, name: str, description: str, files: { type: "object", additionalProperties: { type: ["string", "null"] } } }, ["id", "files"])],
  ["set_plugin_enabled", "Enable or disable a terminal plugin.", schema({ id: str, enabled: bool }, ["id", "enabled"])],
  ["undo_plugin", "Restore the previous saved version of a terminal plugin.", schema({ id: str }, ["id"])],
  ["delete_plugin", "Move a terminal plugin into recoverable trash.", schema({ id: str }, ["id"])],
  ["set_safe_mode", "Disable all user plugins, or resume them.", schema({ enabled: bool }, ["enabled"])],
  ["list_terminals", "List pane ids, providers, names and focus in this terminal window.", schema()],
  ["open_terminal", "Open an installed agent or shell in a new tab or split.", schema({ provider: str, name: str, cwd: str, mode: { enum: ["tab", "right", "down"] } })],
  ["read_terminal", "Read plain screen and scrollback text from a pane. Do not disclose secrets.", schema({ id, lines: { type: "integer", minimum: 1, maximum: 2000 } }, ["id"])],
  ["write_terminal", "Send raw text to a pane; enter submits it. This can execute commands, so use only for user-authorized actions.", schema({ id, text: str, enter: bool }, ["id", "text"])],
  ["rename_terminal", "Rename a terminal pane.", schema({ id, name: str }, ["id", "name"])],
  ["focus_terminal", "Focus a terminal pane.", schema({ id }, ["id"])],
  ["close_terminal", "Close a pane and stop its process. Confirm before discarding running work.", schema({ id }, ["id"])],
  ["terminal_settings", "Read or persist sidebar visibility and RGB theme tokens.", schema({ sidebar: bool, theme: { type: "object", additionalProperties: str } })],
  ["list_commands", "List commands contributed by terminal plugins.", schema()],
  ["run_command", "Run a plugin command the user asked for.", schema({ id: str }, ["id"])],
  ["reload_terminal", "Reload the terminal UI code while keeping panes running.", schema()],
].map(([name, description, inputSchema]) => ({ name, description, inputSchema }));

function mcpConfig(hubFile, script = path.join(__dirname, "..", "mcp", "jagents-terminal-mcp.cjs")) {
  return { mcpServers: { [SERVER]: { command: process.execPath, args: [script], ...(hubFile ? { env: { JAGENTS_TERMINAL_HUB_FILE: hubFile } } : {}) } } };
}

function createRuntime(host, options = {}) {
  const dataRoot = options.dataRoot || DATA;
  const home = options.home || HOME;
  const db = openDb(dataRoot);
  const events = new EventEmitter();
  const commands = new Map();
  const token = randomBytes(24).toString("hex");
  const sessionDir = path.join(home, "sessions", String(process.pid) + "-" + randomBytes(6).toString("hex"));
  const hubFile = path.join(sessionDir, "hub.json");
  const defaultHub = path.join(home, "hub.json");
  let server = null;
  let started = false;
  let activated = false;
  let closed = false;

  function notify(text) {
    host.ui()?.flash(String(text));
  }

  function control(action, args) {
    const ui = host.ui();
    if (!ui?.control) throw new Error("The terminal UI is not ready.");
    return ui.control(action, args || {});
  }

  function settings(patch) {
    const before = db.getSetting("terminal.settings", { sidebar: true, theme: {} });
    if (!patch || !Object.keys(patch).length) return before;
    const next = { ...before };
    if ("sidebar" in patch) {
      if (typeof patch.sidebar !== "boolean") throw new Error("sidebar must be a boolean.");
      next.sidebar = patch.sidebar;
    }
    if ("theme" in patch) {
      const allowed = ["canvas", "surface", "well", "line", "ink", "muted", "faint", "accent", "accentInk", "accentSoft", "ok", "warn", "danger", "paneFg", "paneBg"];
      for (let i = 0; i < 16; i++) allowed.push("ansi" + i);
      if (!patch.theme || typeof patch.theme !== "object" || Array.isArray(patch.theme)) throw new Error("theme must be an object.");
      for (const [key, rgb] of Object.entries(patch.theme)) {
        if (!allowed.includes(key) || typeof rgb !== "string" || !/^\d{1,3};\d{1,3};\d{1,3}$/.test(rgb) || rgb.split(";").some((v) => Number(v) > 255)) throw new Error("Invalid RGB theme token: " + key);
      }
      next.theme = { ...patch.theme };
    }
    db.setSetting("terminal.settings", next);
    host.ui()?.applySettings(next);
    return next;
  }

  const plugins = createPluginManager({
    dataRoot, db, docs, renderer: false, retire: false, reservedServers: [SERVER],
    emit: (type) => {
      if (type === "plugins-state") host.ui()?.pluginsChanged?.();
      host.ui()?.schedule();
    },
    notify, log: () => {},
    context(ctx) {
      const terminal = Object.fromEntries(["list", "open", "read", "write", "rename", "focus", "close"].map((action) => [action, (args) => control(action, args)]));
      terminal.settings = settings;
      terminal.on = (event, fn) => {
        events.on(event, fn);
        const off = () => events.off(event, fn);
        ctx.dispose(off);
        return off;
      };
      terminal.commands = {
        register(def) {
          if (!def || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(def.id) || typeof def.handler !== "function") throw new Error("A command needs an id and handler.");
          const key = ctx.id + "." + def.id;
          const command = { id: key, plugin: ctx.id, label: String(def.label || def.id), handler: def.handler };
          if (commands.has(key)) throw new Error("Command already registered: " + key);
          commands.set(key, command);
          const off = () => { if (commands.get(key) === command) commands.delete(key); };
          ctx.dispose(off);
          return off;
        },
      };
      return {
        terminal,
        storage: {
          get: (key, fallback) => db.getSetting("plugin." + ctx.id + "." + key, fallback),
          set: (key, value) => db.setSetting("plugin." + ctx.id + "." + key, value),
        },
      };
    },
  });

  function disabled() {
    return new Set(plugins.agentMcp().disabled);
  }

  function tools() {
    const off = disabled();
    return TOOLS.filter((t) => !off.has(SERVER + "." + t.name));
  }

  async function call(name, a = {}, caller) {
    if (disabled().has(SERVER + "." + name)) throw new Error(name + " is disabled by a terminal plugin.");
    const author = caller?.paneId ? "terminal-" + caller.paneId : "external";
    switch (name) {
      case "plugin_docs": return docs;
      case "list_plugins": return plugins.list();
      case "read_plugin": return plugins.read(a.id);
      case "write_plugin": return plugins.write(a.id, a, author);
      case "set_plugin_enabled":
        if (typeof a.enabled !== "boolean") throw new Error("enabled must be a boolean.");
        return plugins.setEnabled(a.id, a.enabled, author);
      case "undo_plugin": return plugins.undo(a.id, author);
      case "delete_plugin": return plugins.remove(a.id, author);
      case "set_safe_mode":
        if (typeof a.enabled !== "boolean") throw new Error("enabled must be a boolean.");
        return plugins.setSafeMode(a.enabled);
      case "list_terminals": return control("list");
      case "open_terminal": return control("open", a);
      case "read_terminal": return control("read", a);
      case "write_terminal": return control("write", a);
      case "rename_terminal": return control("rename", a);
      case "focus_terminal": return control("focus", a);
      case "close_terminal": return control("close", a);
      case "terminal_settings": return settings(a);
      case "list_commands": return commandList();
      case "run_command": {
        const command = commands.get(String(a.id));
        if (!command) throw new Error("No plugin command " + a.id);
        return (await command.handler()) ?? { ran: command.id };
      }
      case "reload_terminal":
        if (!host.reload) throw new Error("Reload is unavailable.");
        setImmediate(() => host.reload());
        return { reloading: true, terminalsKept: true };
      default: throw new Error("Unknown terminal tool: " + name);
    }
  }

  function commandList() {
    return Array.from(commands.values(), ({ id, plugin, label }) => ({ id, plugin, label }));
  }

  function emit(event, payload) {
    for (const fn of events.listeners(event)) {
      try { Promise.resolve(fn(payload)).catch((e) => notify("Plugin event failed: " + e.message)); }
      catch (e) { notify("Plugin event failed: " + e.message); }
    }
  }

  function paneSpec(provider, spec, paneId) {
    const inherited = { JAGENTS_TERMINAL_HUB_FILE: hubFile, JAGENTS_PANE_ID: String(paneId) };
    const config = mcpConfig(hubFile);
    const extra = plugins.agentMcp();
    for (const entry of extra.external) config.mcpServers[entry.name] = { command: entry.command, args: entry.args, env: entry.env };
    for (const entry of extra.inApp) config.mcpServers[entry.name] = {
      command: process.execPath, args: [path.join(__dirname, "..", "mcp", "jagents-plugin-mcp.cjs")],
      env: { JAGENTS_HUB_FILE: hubFile, JAGENTS_SERVER: entry.name },
    };
    for (const entry of Object.values(config.mcpServers)) entry.env = { ...entry.env, JAGENTS_PANE_ID: String(paneId) };
    const args = spec.args.slice();
    if (provider === "claude") {
      args.push("--mcp-config", JSON.stringify(config));
      if (extra.disabled.length) args.push("--disallowedTools", extra.disabled.map((t) => t.includes(".") ? "mcp__" + t.replace(".", "__") : t).join(","));
    } else if (provider === "codex") {
      for (const [name, entry] of Object.entries(config.mcpServers)) {
        const prefix = "mcp_servers." + JSON.stringify(name);
        args.push("-c", prefix + ".command=" + JSON.stringify(entry.command), "-c", prefix + ".args=" + JSON.stringify(entry.args));
        for (const [key, value] of Object.entries(entry.env || {})) args.push("-c", prefix + ".env." + JSON.stringify(key) + "=" + JSON.stringify(String(value)));
        const off = extra.disabled.filter((t) => t.startsWith(name + ".")).map((t) => t.slice(name.length + 1));
        if (off.length) args.push("-c", prefix + ".disabled_tools=" + JSON.stringify(off));
      }
    }
    return { ...spec, args, env: { ...spec.env, ...inherited } };
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error("Request exceeds 4 MB.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  async function start() {
    if (started) return;
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    server = http.createServer(async (req, res) => {
      const reply = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== "Bearer " + token) return reply(401, { error: "Bad token" });
      try {
        const match = /^\/servers\/([a-zA-Z0-9_-]{1,40})\/(tools|call)$/.exec(req.url);
        if (!match) return reply(404, { error: "Not found" });
        const name = match[1];
        if (req.method === "GET" && match[2] === "tools") return reply(200, name === SERVER ? { tools: tools(), description: "Control this JAgents terminal window and its trusted plugins. Only perform user-authorized changes." } : plugins.appServerTools(name));
        if (req.method !== "POST" || match[2] !== "call") return reply(405, { error: "Method not allowed" });
        const body = await readBody(req);
        // A pane id is attribution, not an authorization boundary. The bearer
        // token grants same-user access to the window, as in the desktop hub.
        const caller = { paneId: String(body.caller?.paneId || "") };
        const result = name === SERVER ? await call(body.name, body.args || {}, caller) : await plugins.callAppServer(name, body.name, body.args || {}, caller);
        return reply(200, { result: result ?? null });
      } catch (e) { return reply(400, { error: String(e.message || e) }); }
    });
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const record = JSON.stringify({ port: server.address().port, token, pid: process.pid });
      fs.writeFileSync(hubFile, record, { mode: 0o600 });
      const temp = defaultHub + "." + randomBytes(6).toString("hex") + ".tmp";
      fs.writeFileSync(temp, record, { mode: 0o600 });
      fs.renameSync(temp, defaultHub);
      started = true;
      if (!options.deferPlugins) activate();
    } catch (error) { stop(); throw error; }
  }

  function activate() {
    if (activated) return;
    activated = true;
    plugins.start({ hubCall: call });
  }

  function stop() {
    if (closed) return;
    closed = true;
    plugins.stop();
    if (server) { server.close(); server.closeAllConnections(); }
    try {
      if (JSON.parse(fs.readFileSync(defaultHub, "utf8")).token === token) fs.unlinkSync(defaultHub);
    } catch { /* another window owns the default, or no hub was written */ }
    if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
    events.removeAllListeners();
    db.close();
  }

  return { start, activate, stop, plugins, settings, call, tools, emit, paneSpec, commands: commandList, hubFile, dataRoot };
}

module.exports = { createRuntime, mcpConfig, DATA, HOME, SERVER };
