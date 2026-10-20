"use strict";

// --data-root= and --jagents-home= do what JAGENTS_DATA_ROOT and JAGENTS_HOME
// do, for shortcuts that cannot set environment variables. Read before the
// modules below, which pick up JAGENTS_HOME when they load.
for (const arg of process.argv) {
  const m = /^--(data-root|jagents-home)=(.+)$/.exec(arg);
  if (m) process.env[m[1] === "data-root" ? "JAGENTS_DATA_ROOT" : "JAGENTS_HOME"] = m[2];
}

const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, protocol, shell, dialog, Notification } = require("electron");
const { openDb } = require("../lib/db");
const { listAcpAgents, listTerminalAgents, setExtraAgents } = require("../lib/agents");
const marketplace = require("../lib/acp-marketplace");
const { installAgent } = require("../lib/agent-install");
const { connectPtyHost } = require("./pty-client.cjs");
const { createAcpHost } = require("./acp-host.cjs");
const { createWorkspace } = require("./workspace.cjs");
const { createHub, HOME_DIR } = require("./hub.cjs");
const { createPluginManager } = require("./plugins.cjs");
const mcpInstall = require("./mcp-install.cjs");
const { findLegacyRoots, importLegacy } = require("../lib/migrate");
const { createUpdater } = require("../lib/updater");
const { setupTaskbarIcon } = require("./win-taskbar.cjs");

const APP_ROOT = path.join(__dirname, "..");
const RENDERER = path.join(APP_ROOT, "renderer");
const VENDOR = {
  "xterm.js": path.join(APP_ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.js"),
  "xterm.css": path.join(APP_ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
  "addon-fit.js": path.join(APP_ROOT, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"),
};
const SHELL_URL = "app://shell/index.html";

// JAgents started from inside a Claude Code session (a terminal or the desktop
// app) inherits that session's markers; agents launched here would think they
// are its children (no transcript saving, the host's proxy and socket). Drop them.
if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) {
  for (const key of Object.keys(process.env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.+|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE|ANTHROPIC_BASE_URL)$/.test(key)) delete process.env[key];
  }
}

app.setName("JAgents");
// Some sandboxed or remote sessions crash the GPU process; this falls back to software rendering.
if (process.env.JAGENTS_DISABLE_GPU === "1") app.disableHardwareAcceleration();
const DATA_ROOT = process.env.JAGENTS_DATA_ROOT ? path.resolve(process.env.JAGENTS_DATA_ROOT) : path.join(app.getPath("appData"), "JAgents");
// Before the rebrand the data folder was "Relay ADE"; copy it once.
// Relay ADE data comes in only when the user presses "Get data from legacy
// Relay" in MCP hub (lib/migrate.js). That leaves a flag file and restarts, so
// the import runs before the database opens. A test data root only sees Relay
// data when JAGENTS_LEGACY_ROOT names the folder.
const LEGACY_ROOT = process.env.JAGENTS_LEGACY_ROOT || "";
const LEGACY_ON = Boolean(LEGACY_ROOT || !process.env.JAGENTS_DATA_ROOT);
const IMPORT_FLAG = path.join(DATA_ROOT, "import-relay-data");

function legacyRoot() {
  if (!LEGACY_ON) return "";
  return LEGACY_ROOT || findLegacyRoots(app.getPath("appData"))[0] || "";
}
app.setPath("userData", DATA_ROOT);

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };

let db = null;
let ptyHost = null;
let taskbar = null;
let acp = null;
let workspace = null;
let hub = null;
let plugins = null;
let mainWindow = null;
let updater = null;
let autoMcp = { at: 0, changes: [], running: false };
let legacyData = { status: "off" };

function broadcast(type, payload) {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send("app-event", { type, payload });
}

function insideDir(root, rel) {
  const abs = path.resolve(root, "." + path.sep + rel);
  return abs === path.resolve(root) || abs.startsWith(path.resolve(root) + path.sep) ? abs : null;
}

async function serveFile(file) {
  try {
    const body = await fs.promises.readFile(file);
    return new Response(body, { headers: { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store" } });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function registerProtocol() {
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    if (url.host !== "shell") return new Response("Not found", { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    // Plugin files: plugins/<id>@<stamp>/<file>. The stamp changes on every
    // edit so the window re-imports a changed renderer.js.
    const plug = /^plugins\/([a-z0-9][a-z0-9-]{0,39})@\d+\/(.+)$/.exec(rel);
    if (plug && plugins) {
      const file = insideDir(path.join(plugins.dir, plug[1]), plug[2]);
      return file ? serveFile(file) : new Response("Not found", { status: 404 });
    }
    if (rel.startsWith("vendor/")) {
      const file = VENDOR[rel.slice("vendor/".length)];
      return file ? serveFile(file) : new Response("Not found", { status: 404 });
    }
    const file = insideDir(RENDERER, rel);
    return file ? serveFile(file) : new Response("Not found", { status: 404 });
  });
}

function theme() {
  return db.getSetting("theme", "dark") === "light" ? "light" : "dark";
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "JAgents",
    icon: path.join(APP_ROOT, "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    backgroundColor: theme() === "dark" ? "#16181d" : "#f5f6f8",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  mainWindow.setMenuBarVisibility(false);
  if (taskbar && taskbar.details) mainWindow.setAppDetails(taskbar.details);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("app://shell/")) event.preventDefault();
  });
  // Safe mode: if a plugin breaks the window, Ctrl+Shift+F12 turns every plugin off and reloads.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F12" && input.control && input.shift) {
      event.preventDefault();
      if (plugins) plugins.setSafeMode(true);
      mainWindow.webContents.reload();
    }
  });
  mainWindow.loadURL(SHELL_URL);
  mainWindow.on("closed", () => (mainWindow = null));
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => fn(...args));
}

function notify(text) {
  broadcast("toast", { text });
  if (mainWindow && !mainWindow.isFocused() && Notification.isSupported()) new Notification({ title: "JAgents", body: text }).show();
}

function registerIpc() {
  handle("app-info", () => ({ dataRoot: DATA_ROOT, hubDir: HOME_DIR, theme: theme(), cwd: workspace.cwdDefault(), hubAttach: workspace.hubOn(), hubChosen: db.getSetting("hub.chosen", false), mode: db.getSetting("mode", "code"), version: updater.state().current, mcpAutoUpdate: db.getSetting("mcp.autoUpdate", true), mcpAutoInstall: db.getSetting("mcp.autoInstall", false), layout: db.getSetting("layout", "grid"), threadCurrent: db.getSetting("thread.current", ""), platform: process.platform }));
  handle("set-setting", (key, value) => {
    const allowed = ["theme", "mode", "layout", "hub.attach", "hub.chosen", "thread.current", "ui.sidebar", "mcp.autoUpdate", "mcp.autoInstall", "help.section"];
    if (!allowed.includes(key)) throw new Error("Unknown setting " + key);
    db.setSetting(key, value);
    return true;
  });
  handle("pick-folder", async () => {
    const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"], defaultPath: workspace.cwdDefault() });
    if (res.canceled || !res.filePaths[0]) return null;
    db.setSetting("cwd", res.filePaths[0]);
    return res.filePaths[0];
  });
  handle("open-path", (p) => shell.openPath(String(p)));
  handle("open-url", (url) => {
    if (!/^https:\/\//.test(String(url))) throw new Error("Only https links open.");
    return shell.openExternal(String(url));
  });

  handle("agents-list", () => ({ acp: listAcpAgents(), terminal: listTerminalAgents() }));
  handle("marketplace-list", (opts) => marketplace.marketplaceList(db, DATA_ROOT, opts));
  // Installs run one per agent; their state outlives the panel so reopening
  // it shows the progress.
  const installs = new Map();
  handle("marketplace-installs", () => Object.fromEntries(installs));
  handle("marketplace-install", async (id) => {
    const key = String(id || "");
    if (installs.get(key) && installs.get(key).state === "running") return installs.get(key);
    const plan = marketplace.installPlan(DATA_ROOT, key);
    const job = { id: key, name: plan.name, state: "running", line: "Starting…", error: "" };
    installs.set(key, job);
    broadcast("agent-install", job);
    // Reinstalling over a running copy would fail on locked files.
    for (const c of acp.listChats().filter((c) => c.harnessId === key)) acp.stopChat(c.id);
    try {
      const spec = await installAgent(plan, (line) => {
        job.line = line.slice(0, 300);
        broadcast("agent-install", job);
      });
      if (spec) marketplace.saveInstalled(db, plan, spec);
      const found = listAcpAgents().some((a) => a.id === key && a.available);
      job.state = found ? "done" : "failed";
      job.error = found ? "" : plan.name + " installed, but JAgents cannot find it yet. Restart JAgents so it picks up the new PATH.";
      job.line = found ? plan.name + " is installed." : job.line;
    } catch (error) {
      job.state = "failed";
      job.error = String((error && error.message) || error);
    }
    broadcast("agent-install", job);
    broadcast("agents-changed", {});
    return job;
  });
  handle("marketplace-add", (body) => {
    const added = marketplace.addCustomAgent(db, body);
    broadcast("agents-changed", {});
    return added;
  });
  handle("marketplace-remove", async (id) => {
    const key = String(id || "");
    const chats = acp.listChats().filter((c) => c.harnessId === key);
    const res = await dialog.showMessageBox(mainWindow, { type: "warning", buttons: ["Uninstall", "Cancel"], defaultId: 1, cancelId: 1, message: "Uninstall this agent?", detail: (chats.length ? "Its running chats stop. Its " + chats.length + " thread" + (chats.length === 1 ? "" : "s") + " keep their transcripts and can be handed to another agent. " : "") + "Files JAgents downloaded for it are deleted.", noLink: true });
    if (res.response !== 0) return false;
    // A removed agent must not keep running with no picker entry to stop it.
    for (const c of chats) acp.stopChat(c.id);
    const removed = marketplace.removeAgent(db, DATA_ROOT, key);
    broadcast("agents-changed", {});
    return removed;
  });
  handle("panes-list", () => workspace.list());
  handle("pane-add-terminal", (opts) => workspace.addTerminal(opts));
  handle("pane-add-chat", (opts) => workspace.addChatPane(opts));
  handle("pane-remove", async (id, opts) => {
    const pane = workspace.list().find((p) => p.id === id);
    if (pane && pane.kind === "terminal" && pane.status !== "exited" && !(opts && opts.confirmed)) {
      const res = await dialog.showMessageBox(mainWindow, { type: "warning", buttons: ["Close terminal", "Cancel"], defaultId: 1, cancelId: 1, message: "Close " + pane.handle + "?", detail: "The " + pane.name + " process in this terminal will be stopped.", noLink: true });
      if (res.response !== 0) return false;
    }
    return workspace.removePane(id, opts);
  });
  handle("pane-reorder", (ids) => workspace.reorder(ids));
  handle("hub-agents", () => workspace.agents());
  handle("hub-activity", () => hub.activity());

  handle("pty-attach", (id, size) => workspace.ensureTerminal(id, size));
  handle("pty-restart", (id, size) => workspace.restartTerminal(id, size));
  ipcMain.on("pty-write", (_e, id, data) => ptyHost.write(id, data));
  ipcMain.on("pty-resize", (_e, id, cols, rows) => ptyHost.resize(id, cols, rows));

  handle("chats-list", () => acp.listChats());
  handle("chat-get", (id) => acp.snapshot(id));
  handle("chat-create", (opts) => workspace.newChat(opts));
  handle("chat-prompt", (id, text) => acp.prompt(id, text));
  handle("chat-cancel", (id) => acp.cancel(id));
  handle("chat-set-model", (id, modelId) => acp.setModel(id, modelId));
  handle("chat-handoff", (id, harnessId) => acp.handoff(id, harnessId));
  handle("chat-authenticate", (id, methodId, secret) => acp.authenticate(id, methodId, secret));
  handle("chat-delete", async (id) => {
    const res = await dialog.showMessageBox(mainWindow, { type: "warning", buttons: ["Delete thread", "Cancel"], defaultId: 1, cancelId: 1, message: "Delete this thread?", detail: "Its transcript is removed from JAgents. This cannot be undone.", noLink: true });
    if (res.response !== 0) return false;
    const pane = workspace.paneForChat(id);
    if (pane) workspace.removePane(pane.id);
    return acp.deleteChat(id);
  });
  handle("agent-model-info", (id) => acp.modelInfo(id));
  handle("agent-set-model", (id, modelId) => acp.setModelPref(id, modelId));
  handle("agent-probe", (id) => acp.probe(id));

  // Context handoff from the pane header.
  handle("handoff", async (sourceId, opts) => {
    const source = workspace.findAgent(sourceId);
    if (!source) throw new Error("That agent is not running.");
    return hub.handoff(source, opts);
  });

  handle("plugins-list", () => plugins.list());
  handle("plugins-read", (id) => plugins.read(id));
  handle("plugins-write", (id, input) => plugins.write(id, input, "you"));
  handle("plugins-enable", (id, on) => plugins.setEnabled(id, on, "you"));
  handle("plugins-undo", (id) => plugins.undo(id, "you"));
  handle("plugins-remove", async (id) => {
    const p = plugins.info(id);
    const res = await dialog.showMessageBox(mainWindow, { type: "warning", buttons: ["Remove plugin", "Cancel"], defaultId: 1, cancelId: 1, message: "Remove " + p.name + "?", detail: "Its folder moves to the plugins trash (" + path.join(plugins.dir, ".trash") + "), so it can be put back by hand.", noLink: true });
    if (res.response !== 0) return false;
    return plugins.remove(id, "you");
  });
  handle("plugins-scaffold", () => plugins.scaffold());
  handle("plugins-report", (id, result) => plugins.report(id, result));
  handle("plugins-invoke", (id, channel, payload) => plugins.invoke(id, channel, payload));
  handle("plugins-safe", (on) => plugins.setSafeMode(on));
  handle("plugins-open-folder", (id) => shell.openPath(id ? path.join(plugins.dir, String(id).replace(/[^a-z0-9-]/g, "")) : plugins.dir));
  // Plugin storage lives in jagents.db, one settings row per plugin.
  handle("plugins-storage-get", (id) => db.getSetting("plugin-store:" + String(id), {}) || {});
  handle("plugins-storage-set", (id, key, value) => {
    const k = "plugin-store:" + String(id);
    const cur = db.getSetting(k, {}) || {};
    if (value === undefined || value === null) delete cur[String(key)];
    else cur[String(key)] = value;
    db.setSetting(k, cur);
    return true;
  });
  handle("pane-add-plugin", (opts) => workspace.addPluginPane(opts));
  handle("pane-plugin-update", (id, patch) => workspace.updatePluginPane(id, patch));

  handle("mcp-status", () => mcpInstall.status(hub.files.script));
  handle("mcp-install", (id) => mcpInstall.install(id, hub.files.script));
  handle("mcp-uninstall", (id) => mcpInstall.uninstall(id, hub.files.script));
  handle("mcp-support", () => mcpInstall.support());
  handle("mcp-auto-state", () => autoMcp);
  handle("mcp-auto-run", () => runAutoMcp(true));
  handle("hub-tools", () => ({ server: mcpInstall.NAME, tools: hub.tools() }));
  handle("legacy-state", () => legacyState());
  // Get data from legacy Relay: agent configs that had the relay server get
  // the jagents one now; threads, layout and plugins come in on restart.
  handle("legacy-import", async () => {
    if (!legacyRoot()) throw new Error("No Relay data was found on this computer.");
    const mcps = await mcpInstall.importLegacyMcp(hub.files.script);
    fs.writeFileSync(IMPORT_FLAG, new Date().toISOString());
    return { mcps };
  });

  handle("update-state", () => updater.state());
  handle("update-check", () => updater.check());
  handle("update-apply", () => updater.apply());
  handle("app-restart", () => {
    restartApp();
    return true;
  });
}

// Terminals live in the pty daemon, so a restart leaves them running and the
// next app adopts them; a real quit closes them.
let restarting = false;
function restartApp() {
  restarting = true;
  app.relaunch();
  app.quit();
}

// The Legacy (development) button's state for the MCP hub panel.
function legacyState() {
  return { data: legacyData, root: legacyRoot(), pending: fs.existsSync(IMPORT_FLAG), imported: db.getSetting("legacy.imported", null) };
}

// Auto MCP: keep global installs pointing at this build's script and (when
// turned on) install into every supported agent.
async function runAutoMcp(force) {
  if (!force && !db.getSetting("mcp.autoUpdate", true)) return autoMcp;
  autoMcp = Object.assign({}, autoMcp, { running: true });
  broadcast("mcp-auto", autoMcp);
  try {
    const res = await mcpInstall.autoUpdate(hub.files.script, { installMissing: Boolean(db.getSetting("mcp.autoInstall", false)) });
    autoMcp = { at: res.at, changes: res.changes, running: false };
    const done = res.changes.filter((c) => c.action !== "failed");
    if (done.length) notify("Auto MCP " + done.map((c) => c.action + " " + c.id).join(", ") + ".");
  } catch (error) {
    autoMcp = { at: Date.now(), changes: [{ id: "all", action: "failed", error: String(error.message || error) }], running: false };
  }
  broadcast("mcp-auto", autoMcp);
  return autoMcp;
}

app.whenReady().then(async () => {
  if (fs.existsSync(IMPORT_FLAG)) {
    try {
      const root = legacyRoot();
      legacyData = root ? Object.assign({ status: "imported" }, importLegacy(root, DATA_ROOT)) : { status: "none" };
      if (root) console.log("Imported Relay ADE data from " + root);
    } catch (error) {
      legacyData = { status: "error", error: String(error.message || error) };
      console.error("Could not import Relay ADE data: " + error.message);
    }
    fs.rmSync(IMPORT_FLAG, { force: true });
  }
  db = openDb(DATA_ROOT);
  setExtraAgents(() => marketplace.extraAgents(db));
  updater = createUpdater({ appRoot: APP_ROOT, emit: broadcast });
  registerProtocol();
  ptyHost = await connectPtyHost({ emit: broadcast, dataRoot: DATA_ROOT });
  if (ptyHost.adopted.length) console.log("Reattached " + ptyHost.adopted.length + " terminals that kept running");
  const hubFiles = { hub: path.join(HOME_DIR, "hub.json"), script: path.join(HOME_DIR, "jagents-mcp.cjs"), pluginScript: path.join(HOME_DIR, "jagents-plugin-mcp.cjs") };
  plugins = createPluginManager({ dataRoot: DATA_ROOT, db, emit: broadcast, notify, log: (t) => console.log(t), bundledDir: path.join(APP_ROOT, "plugins"), getWindow: () => mainWindow });
  let ws = null;
  acp = createAcpHost({
    dataRoot: DATA_ROOT,
    db,
    emit: broadcast,
    defaultCwd: () => (ws ? ws.cwdDefault() : require("node:os").homedir()),
    // ACP and Claude SDK chats always get the jagents server (and plugin
    // servers); the hub switch only governs terminals.
    mcpEntryFor: (chatId) => (ws ? ws.mcpEntries(chatId, true) : []),
    disallowedFor: () => (ws ? ws.claudeDisallowed() : []),
    contextFor: (chatId) => {
      const chat = db.getChat(chatId);
      const handleName = chat ? chat.handle : "this agent";
      const base = "You are " + handleName + ", running in JAgents next to other coding agents. Your working folder is " + ((chat && chat.cwd) || "") + ".";
      const parent = chat && chat.parentId ? ws.findAgent(chat.parentId) : null;
      const sub = parent ? " You are a subagent started by " + parent.handle + "; finish the task, then reply with a short, complete summary of what you did and found. Your final message is returned to " + parent.handle + "." : "";
      const tools = ws ? " The jagents MCP tools (list_agents, send_message, read_agent, spawn_subagent, wait_for_agent, handoff_context) let you work with the other agents." : "";
      return base + sub + tools;
    },
  });
  ws = createWorkspace({ db, dataRoot: DATA_ROOT, ptyHost, acpHost: acp, emit: broadcast, hubFiles, pluginMcp: () => plugins.agentMcp() });
  workspace = ws;
  hub = createHub({ workspace, ptyHost, acpHost: acp, plugins, dataRoot: DATA_ROOT, emit: broadcast, notify, restartApp });
  await hub.start();
  plugins.start({ hubCall: (name, args) => hub.call(name, args, null), onToolsChanged: () => hub.toolsChanged() });
  workspace.launchRestored();
  registerIpc();
  try {
    taskbar = setupTaskbarIcon({ app, shell, appRoot: APP_ROOT, icoPath: path.join(APP_ROOT, "build", "icon.ico"), customRoot: process.env.JAGENTS_DATA_ROOT ? DATA_ROOT : "", jagentsHome: process.env.JAGENTS_HOME ? HOME_DIR : "", log: (t) => console.log(t) });
  } catch (error) {
    console.error("Taskbar icon: " + error.message);
  }
  createWindow();
  // Repairs the taskbar icon if a stray shortcut or a removed one breaks it.
  // The window's ID is cleared and set again so Windows redraws its button.
  if (taskbar && taskbar.check) {
    setInterval(() => {
      if (!taskbar.check() || !mainWindow || mainWindow.isDestroyed() || !taskbar.details) return;
      mainWindow.setAppDetails({ appId: "" });
      mainWindow.setAppDetails(taskbar.details);
    }, 30 * 1000);
  }
  runAutoMcp(false);
  setInterval(() => runAutoMcp(false), 10 * 60 * 1000);
  setTimeout(() => updater.check(), 8000);
  setInterval(() => updater.check(), 6 * 60 * 60 * 1000);
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  try {
    if (acp) acp.stopAll();
    if (plugins) plugins.stop();
    if (hub) hub.stop();
  } catch {
    /* quitting */
  }
  if (!ptyHost) return;
  // Hold the quit until the daemon has the message.
  event.preventDefault();
  (restarting ? ptyHost.detach() : ptyHost.shutdown()).finally(() => app.quit());
});

app.on("window-all-closed", () => app.quit());
