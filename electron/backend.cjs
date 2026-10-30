"use strict";

// The JAgents app behind the page: the database, the pty daemon's terminals,
// chats (ACP and Claude Code), the MCP hub, plugins, updates and every IPC
// channel the page uses. Loading this file does nothing; a host creates the
// backend and hands it its window and IPC:
//   electron/main.cjs        the desktop app, in its own window
//   electron/jworkspace.cjs  inside JWorkspace, a view in JWorkspace's window
//
// createBackend(opts):
//   dataRoot, homeDir   the data folder and the hub's folder (~/.jagents)
//   host                "desktop" or "jworkspace" (app-info.host)
//   smoke               hidden test run: no usage polling or update checks
//   env                 base environment for the programs JAgents starts
//                       (process.env when not given)
//   legacy              { on, root }: getting Relay ADE data (lib/migrate.js)
//   argv                checked for --project= at start
//   handle(name, fn)    like ipcMain.handle, fn(event, ...args)
//   on(name, fn)        like ipcMain.on
//   send(channel, msg)  an event to the page
//   getWindow()         the BrowserWindow: dialog parent and focus
//   surface()           { contentView, webContents } when the page is a view in
//                       another app's window; plugins get a window stand-in
//   restart()           the desktop app relaunches; JWorkspace reloads it in place
//   focus()             bring JAgents forward
//   lost()              after the backend stopped on its own because another
//                       JAgents took its terminals (see lose())
//   print(text)         console output (console.log when not given)
//   features            { titlebar, autoMcp, updaterApply, notifications }
//
// It returns serve(request) for the page's scheme (any scheme, host "shell"),
// start(), stop({ detach }), onPage(webContents), openProject(argv),
// childProcessGone(details), theme() and daemonPid().

const fs = require("node:fs");
const path = require("node:path");
const { app, shell, dialog, Notification, nativeTheme } = require("electron");
const { openDb } = require("../lib/db");
const { listAcpAgents, listTerminalAgents, setExtraAgents } = require("../lib/agents");
const marketplace = require("../lib/acp-marketplace");
const { installAgent } = require("../lib/agent-install");
const { setChildEnv } = require("../lib/child-env");
const { connectPtyHost } = require("./pty-client.cjs");
const { createAcpHost } = require("./acp-host.cjs");
const { createWorkspace } = require("./workspace.cjs");
const { createHub } = require("./hub.cjs");
const { createPluginManager } = require("./plugins.cjs");
const { createUsage } = require("./usage.cjs");
const mcpInstall = require("./mcp-install.cjs");
const { findLegacyRoots, importLegacy } = require("../lib/migrate");
const { createUpdater } = require("../lib/updater");
const { searchFiles } = require("../lib/file-mentions");
const { createLog, watchWindow } = require("./window-health.cjs");

const APP_ROOT = path.join(__dirname, "..");
const RENDERER = path.join(APP_ROOT, "renderer");
const VENDOR = {
  "xterm.js": path.join(APP_ROOT, "node_modules", "@xterm", "xterm", "lib", "xterm.js"),
  "xterm.css": path.join(APP_ROOT, "node_modules", "@xterm", "xterm", "css", "xterm.css"),
  "addon-fit.js": path.join(APP_ROOT, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js"),
  "addon-webgl.js": path.join(APP_ROOT, "node_modules", "@xterm", "addon-webgl", "lib", "addon-webgl.js"),
  "addon-unicode11.js": path.join(APP_ROOT, "node_modules", "@xterm", "addon-unicode11", "lib", "addon-unicode11.js"),
  "addon-unicode-graphemes.js": path.join(APP_ROOT, "node_modules", "@xterm", "addon-unicode-graphemes", "lib", "addon-unicode-graphemes.js"),
  "addon-search.js": path.join(APP_ROOT, "node_modules", "@xterm", "addon-search", "lib", "addon-search.js"),
  "addon-web-links.js": path.join(APP_ROOT, "node_modules", "@xterm", "addon-web-links", "lib", "addon-web-links.js"),
  // Chat markdown: parser, sanitizer, code highlighting (ES modules).
  "marked.js": path.join(APP_ROOT, "node_modules", "marked", "lib", "marked.esm.js"),
  "purify.js": path.join(APP_ROOT, "node_modules", "dompurify", "dist", "purify.es.mjs"),
  "highlight.js": path.join(APP_ROOT, "node_modules", "@highlightjs", "cdn-assets", "es", "highlight.min.js"),
};

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".woff2": "font/woff2", ".json": "application/json" };

const TITLEBAR_H = 38;

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

// Windows build number, so the terminals know how ConPTY redraws on resize.
function osBuild() {
  return process.platform === "win32" ? Number(require("node:os").release().split(".")[2]) || 0 : 0;
}

function createBackend(opts) {
  const DATA_ROOT = path.resolve(opts.dataRoot);
  const HOME_DIR = path.resolve(opts.homeDir);
  const host = opts.host || "desktop";
  const features = Object.assign({ titlebar: true, autoMcp: true, updaterApply: true, notifications: true }, opts.features);
  const smoke = Boolean(opts.smoke);
  const legacy = opts.legacy || { on: false, root: "" };
  const print = opts.print || ((text) => console.log(text));
  // Dialog parent; several handlers below name their own argument "opts".
  const getWindow = () => opts.getWindow();
  const IMPORT_FLAG = path.join(DATA_ROOT, "import-relay-data");

  let db = null;
  let ptyHost = null;
  let acp = null;
  let workspace = null;
  let hub = null;
  let plugins = null;
  let windowHealth = null;
  let updater = null;
  let usage = null;
  let started = false;
  let starting = null;
  let stopped = false;
  let stopping = null;
  const timers = new Set();
  const pages = new Set(); // page watchers to undo on stop
  const log = createLog(path.join(DATA_ROOT, "jagents.log"), print);
  let autoMcp = { at: 0, changes: [], running: false };
  let legacyData = { status: "off" };

  function legacyRoot() {
    if (!legacy.on) return "";
    return legacy.root || findLegacyRoots(app.getPath("appData"))[0] || "";
  }

  // Events go to the page only while the backend runs; a stopping one (an
  // in-process reload) must not mark the new page's terminals exited.
  function broadcast(type, payload) {
    if (!stopped) opts.send("app-event", { type, payload });
  }

  function later(fn, ms, repeat) {
    const t = (repeat ? setInterval : setTimeout)(() => {
      if (!repeat) timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }

  function restartApp() {
    if (!stopped) Promise.resolve(opts.restart()).catch((error) => log("restart failed: " + (error.message || error)));
  }

  // The pty daemon dropped this app without being asked: another JAgents (a
  // build without the owner lock) connected and took the terminals, or the
  // daemon stopped. Two JAgents on one data folder overwrite each other's
  // panes and threads, so this one stops at once and saves nothing more.
  function lose() {
    if (stopped) return;
    log("lost the terminal service: another JAgents may have this data folder open; stopping without saving");
    stop({ lost: true }).then(() => opts.lost && opts.lost());
  }

  function serve(request) {
    const url = new URL(request.url);
    if (url.host !== "shell") return new Response("Not found", { status: 404 });
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    // Plugin files: plugins/<id>@<stamp>/<file>. The stamp changes on every
    // edit so the window re-imports a changed renderer.js.
    const plug = /^plugins\/([a-z0-9][a-z0-9-]{0,39})@\d+\/(.+)$/.exec(rel);
    if (plug && plugins) {
      const file = insideDir(plugins.fileRoot(plug[1]), plug[2]);
      return file ? serveFile(file) : new Response("Not found", { status: 404 });
    }
    // Files attached to chats, for thumbnails in the transcript.
    if (rel.startsWith("attachments/")) {
      const file = insideDir(path.join(DATA_ROOT, "attachments"), rel.slice("attachments/".length));
      return file ? serveFile(file) : new Response("Not found", { status: 404 });
    }
    if (rel.startsWith("vendor/")) {
      const file = VENDOR[rel.slice("vendor/".length)];
      return file ? serveFile(file) : new Response("Not found", { status: 404 });
    }
    const file = insideDir(RENDERER, rel);
    return file ? serveFile(file) : new Response("Not found", { status: 404 });
  }

  function theme() {
    return db.getSetting("theme", "dark") === "light" ? "light" : "dark";
  }

  // After stop the database is closed; a late call (a save the page had
  // waiting) gets a plain answer instead of a database error.
  function handle(channel, fn) {
    opts.handle(channel, async (_event, ...args) => {
      if (stopped) throw new Error("JAgents is stopping.");
      return fn(...args);
    });
  }

  // The window has focus, and inside another app the JAgents page has it too.
  function focused() {
    const win = getWindow();
    if (!win || win.isDestroyed() || !win.isFocused()) return false;
    const s = opts.surface ? opts.surface() : null;
    return !s || !s.webContents || s.webContents.isFocused();
  }

  function notify(text) {
    broadcast("toast", { text });
    if (features.notifications && !smoke && getWindow() && !focused() && Notification.isSupported()) new Notification({ title: "JAgents", body: text }).show();
  }

  // Plugins' ctx.window(). Inside another app the page is a view, so plugins
  // get a stand-in with what they use: contentView for views of their own (in
  // the page's coordinates, hidden with it), the page's webContents, focus.
  function pluginWindow() {
    if (!opts.surface) return getWindow();
    const s = opts.surface();
    if (!s || !s.webContents || !s.contentView) return null;
    const wc = s.webContents;
    const stand = {
      contentView: s.contentView,
      webContents: wc,
      isDestroyed: () => wc.isDestroyed(),
      isFocused: () => focused(),
      focus: () => opts.focus && opts.focus(),
      show: () => opts.focus && opts.focus(),
      getBounds: () => s.contentView.getBounds(),
      getContentBounds: () => s.contentView.getBounds(),
      getContentSize: () => {
        const b = s.contentView.getBounds();
        return [b.width, b.height];
      },
      on: (event, fn) => {
        if (event === "closed") wc.once("destroyed", fn);
        return stand;
      },
      once: (event, fn) => stand.on(event, fn),
      removeListener: (event, fn) => {
        if (event === "closed") wc.removeListener("destroyed", fn);
        return stand;
      },
    };
    return stand;
  }

  function registerIpc() {
    // The page reports in once it has drawn the app (or its start error).
    opts.on("app-ready", () => !stopped && windowHealth && windowHealth.ready());
    // Settled threads used to come from the settle-threads plugin; its saved
    // list carries over the first time.
    function settledThreads() {
      let settled = db.getSetting("thread.settled", null);
      if (!settled) {
        const old = db.getSetting("plugin-store:settle-threads", {}) || {};
        settled = old.settled && typeof old.settled === "object" ? old.settled : {};
        db.setSetting("thread.settled", settled);
        if (old.folded) db.setSetting("thread.settledFolded", true);
      }
      return settled;
    }
    handle("app-info", () => ({ host, dataRoot: DATA_ROOT, hubDir: HOME_DIR, theme: theme(), cwd: workspace.cwdDefault(), hubAttach: workspace.hubOn(), hubChosen: db.getSetting("hub.chosen", false), mode: db.getSetting("mode", "code"), version: updater.state().current, mcpAutoUpdate: db.getSetting("mcp.autoUpdate", true), mcpAutoInstall: db.getSetting("mcp.autoInstall", false), layout: db.getSetting("layout", "grid"), threadCurrent: db.getSetting("thread.current", ""), threadSettled: settledThreads(), threadSettledFolded: Boolean(db.getSetting("thread.settledFolded", false)), platform: process.platform, osBuild: osBuild(), updateAuto: db.getSetting("update.auto", true) !== false, updateSnooze: db.getSetting("update.snooze", null), groups: db.getSetting("ui.groups", null), pageTabs: db.getSetting("ui.pageTabs", 3), sidebarWidth: db.getSetting("ui.sidebarWidth", 0), sidebarHidden: Boolean(db.getSetting("ui.sidebarHidden", false)), terminal: db.getSetting("terminal", null), projects: workspace.projects() }));
    // The page sends its colors so the window buttons match the theme. Inside
    // another app there are no window buttons, and its theme is its own.
    handle("titlebar-colors", (colors) => {
      const mainWindow = getWindow();
      if (!features.titlebar || !mainWindow || !colors || process.platform === "darwin") return false;
      try {
        mainWindow.setTitleBarOverlay({ color: String(colors.color), symbolColor: String(colors.symbolColor), height: TITLEBAR_H });
        const rgb = /^#([0-9a-f]{6})$/i.exec(String(colors.color));
        if (rgb) {
          const n = parseInt(rgb[1], 16);
          nativeTheme.themeSource = 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 128 ? "light" : "dark";
        }
      } catch {
        return false;
      }
      return true;
    });
    handle("set-setting", (key, value) => {
      const allowed = ["update.auto", "update.snooze", "ui.sidebarWidth", "ui.groups", "ui.pageTabs", "ui.sidebarHidden", "theme", "mode", "layout", "hub.attach", "hub.chosen", "thread.current", "thread.settled", "thread.settledFolded", "ui.sidebar", "mcp.autoUpdate", "mcp.autoInstall", "help.section", "terminal"];
      if (!allowed.includes(key)) throw new Error("Unknown setting " + key);
      db.setSetting(key, value);
      return true;
    });
    // Plan limits read from each agent's own sign-in (electron/usage.cjs).
    handle("usage-get", () => usage.list());
    handle("usage-refresh", () => usage.refresh());
    handle("projects-list", () => workspace.projects());
    handle("projects-add", async (dir) => {
      let target = dir;
      if (!target) {
        const res = await dialog.showOpenDialog(getWindow(), { title: "Add a project folder", properties: ["openDirectory", "createDirectory"], defaultPath: workspace.cwdDefault() });
        if (res.canceled || !res.filePaths.length) return null;
        target = res.filePaths[0];
      }
      return workspace.addProject(target);
    });
    handle("projects-remove", (dir) => workspace.removeProject(dir));
    handle("projects-rename", (dir, name) => workspace.renameProject(dir, name));
    handle("workspaces-add", (dir, name) => workspace.addWorkspace(dir, name));
    handle("workspaces-activate", (dir, id) => workspace.setActiveWorkspace(dir, id));
    handle("workspaces-rename", (dir, id, name) => workspace.renameWorkspace(dir, id, name));
    handle("workspaces-remove", (dir, id) => workspace.removeWorkspace(dir, id));
    handle("projects-activate", (dir) => workspace.setActiveProject(dir));
    handle("pick-folder", async () => {
      const res = await dialog.showOpenDialog(getWindow(), { properties: ["openDirectory", "createDirectory"], defaultPath: workspace.cwdDefault() });
      if (res.canceled || !res.filePaths[0]) return null;
      db.setSetting("cwd", res.filePaths[0]);
      return res.filePaths[0];
    });
    handle("open-path", (p) => shell.openPath(String(p)));
    handle("open-url", (url) => {
      // http too: terminals print local dev servers (http://localhost:5173).
      if (!/^https?:\/\//i.test(String(url))) throw new Error("Only web links open.");
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
      const res = await dialog.showMessageBox(getWindow(), { type: "warning", buttons: ["Uninstall", "Cancel"], defaultId: 1, cancelId: 1, message: "Uninstall this agent?", detail: (chats.length ? "Its running chats stop. Its " + chats.length + " thread" + (chats.length === 1 ? "" : "s") + " keep their transcripts and can be handed to another agent. " : "") + "Files JAgents downloaded for it are deleted.", noLink: true });
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
        const res = await dialog.showMessageBox(getWindow(), { type: "warning", buttons: ["Close terminal", "Cancel"], defaultId: 1, cancelId: 1, message: "Close " + pane.handle + "?", detail: "The " + pane.name + " process in this terminal will be stopped.", noLink: true });
        if (res.response !== 0) return false;
      }
      return workspace.removePane(id, opts);
    });
    handle("pane-reorder", (ids) => workspace.reorder(ids));
    handle("hub-agents", () => workspace.agents());
    handle("hub-activity", () => hub.activity());

    handle("pty-attach", (id, size) => workspace.ensureTerminal(id, size));
    handle("pty-restart", (id, size) => workspace.restartTerminal(id, size));
    opts.on("pty-write", (_e, id, data) => !stopped && ptyHost.write(id, data));
    opts.on("pty-resize", (_e, id, cols, rows) => !stopped && workspace.resizeTerminal(id, cols, rows));

    handle("chats-list", () => acp.listChats());
    handle("chat-get", (id) => acp.snapshot(id));
    handle("chat-create", (opts) => workspace.newChat(opts));
    // input: text, or {text, attachments: [{name, mimeType, path} | {name, mimeType, data}]}.
    handle("chat-prompt", (id, input) => acp.prompt(id, input));
    handle("pick-files", async () => {
      const result = await dialog.showOpenDialog(getWindow(), { title: "Attach files", properties: ["openFile", "multiSelections"] });
      return result.canceled ? [] : result.filePaths;
    });
    handle("chat-cancel", (id) => acp.cancel(id));
    handle("chat-set-model", (id, modelId) => acp.setModel(id, modelId));
    handle("chat-set-effort", (id, level) => acp.setEffort(id, level));
    handle("chat-handoff", (id, harnessId) => acp.handoff(id, harnessId));
    handle("chat-authenticate", (id, methodId, secret) => acp.authenticate(id, methodId, secret));
    handle("chat-set-permission-mode", (id, mode) => acp.setPermissionMode(id, mode));
    handle("chat-answer-permission", (id, permissionId, optionId) => acp.answerPermission(id, permissionId, optionId));
    handle("chat-retry", (id) => acp.retry(id));
    handle("chat-queue-edit", (id, queueId, text) => acp.editQueued(id, queueId, text));
    handle("chat-queue-remove", (id, queueId) => acp.removeQueued(id, queueId));
    // Unsent composer text per thread ("new" for a thread not started yet).
    const draftKey = (id) => "chat-draft:" + (/^[A-Za-z0-9-]{1,64}$/.test(String(id)) ? String(id) : "new");
    handle("chat-draft-get", (id) => String(db.getSetting(draftKey(id), "") || ""));
    handle("chat-draft-set", (id, text) => db.setSetting(draftKey(id), String(text || "").slice(0, 100000)));
    // Files for the composer's @ menu, from the chat's folder.
    handle("chat-files", (id, query) => {
      const chat = id ? db.getChat(id) : null;
      return searchFiles((chat && chat.cwd) || workspace.cwdDefault(), query, 30);
    });
    handle("chat-delete", async (id) => {
      const res = await dialog.showMessageBox(getWindow(), { type: "warning", buttons: ["Delete thread", "Cancel"], defaultId: 1, cancelId: 1, message: "Delete this thread?", detail: "Its transcript is removed from JAgents. This cannot be undone.", noLink: true });
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
      if (p.builtin) throw new Error(p.name + " is built into JAgents and cannot be removed.");
      const res = await dialog.showMessageBox(getWindow(), { type: "warning", buttons: ["Remove plugin", "Cancel"], defaultId: 1, cancelId: 1, message: "Remove " + p.name + "?", detail: "Its folder moves to the plugins trash (" + path.join(plugins.dir, ".trash") + "), so it can be put back by hand.", noLink: true });
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
    handle("pane-rename", (id, title) => workspace.renamePane(id, title));

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
    // Inside JWorkspace the app's files are the folder JWorkspace loads; they
    // change there, not from here.
    handle("update-apply", () => {
      if (!features.updaterApply) throw new Error("JWorkspace runs JAgents Desktop from " + APP_ROOT + ". Updates come from that folder, not from here.");
      return updater.apply();
    });
    handle("app-restart", () => {
      restartApp();
      return true;
    });
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

  // `--project=<folder>` (the CLI's Desktop button) opens that folder as the
  // active project, on first launch or in the window that is already running.
  function openProject(argv) {
    const arg = (argv || []).find((a) => String(a).startsWith("--project="));
    if (!arg || !workspace) return;
    try {
      workspace.addProject(path.resolve(arg.slice("--project=".length)));
    } catch (error) {
      log("--project ignored: " + (error.message || error));
    }
  }

  function start() {
    if (starting) throw new Error("JAgents is already started.");
    started = true;
    starting = run();
    return starting;
  }

  // A stop while this runs waits for it; it skips what is left once stopped.
  async function run() {
    log("started v" + require("../package.json").version + ", data in " + DATA_ROOT + (host === "desktop" ? "" : " (inside " + host + ")"));
    if (fs.existsSync(IMPORT_FLAG)) {
      try {
        const root = legacyRoot();
        legacyData = root ? Object.assign({ status: "imported" }, importLegacy(root, DATA_ROOT)) : { status: "none" };
        if (root) print("Imported Relay ADE data from " + root);
      } catch (error) {
        legacyData = { status: "error", error: String(error.message || error) };
        console.error("Could not import Relay ADE data: " + error.message);
      }
      fs.rmSync(IMPORT_FLAG, { force: true });
    }
    db = openDb(DATA_ROOT);
    setExtraAgents(() => marketplace.extraAgents(db));
    updater = createUpdater({ appRoot: APP_ROOT, emit: broadcast });
    usage = createUsage({ emit: broadcast });
    setChildEnv(opts.env);
    ptyHost = await connectPtyHost({ emit: broadcast, dataRoot: DATA_ROOT, env: opts.env, onLost: lose });
    if (stopped) return;
    if (ptyHost.adopted.length) print("Reattached " + ptyHost.adopted.length + " terminals that kept running");
    const hubFiles = { hub: path.join(HOME_DIR, "hub.json"), script: path.join(HOME_DIR, "jagents-mcp.cjs"), pluginScript: path.join(HOME_DIR, "jagents-plugin-mcp.cjs") };
    plugins = createPluginManager({ dataRoot: DATA_ROOT, hubDir: HOME_DIR, db, emit: broadcast, notify, log: print, bundledDir: path.join(APP_ROOT, "plugins"), builtinDir: path.join(APP_ROOT, "builtin"), getWindow: pluginWindow,
      // Subagents ask through their parent's thread (acp-host askForSubagent).
      permissions: { ask: (req) => acp.askForSubagent(req), cancel: (handle) => acp && acp.cancelSubagentPermissions(handle) },
    });
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
        const tools = ws ? ws.toolsNote() : "";
        return base + sub + tools;
      },
    });
    ws = createWorkspace({ db, dataRoot: DATA_ROOT, ptyHost, acpHost: acp, emit: broadcast, hubFiles, pluginMcp: () => plugins.agentMcp() });
    workspace = ws;
    openProject(opts.argv);
    hub = createHub({ workspace, ptyHost, acpHost: acp, plugins, dataRoot: DATA_ROOT, emit: broadcast, notify, restartApp, homeDir: HOME_DIR });
    await hub.start();
    if (stopped) return;
    plugins.start({ hubCall: (name, args) => hub.call(name, args, null), onToolsChanged: () => hub.toolsChanged() });
    workspace.launchRestored();
    registerIpc();
    if (!smoke) usage.start();
    if (features.autoMcp) {
      runAutoMcp(false);
      later(() => runAutoMcp(false), 10 * 60 * 1000, true);
    }
    // Settings > Updates can turn the automatic checks off.
    if (!smoke) {
      const autoCheck = () => db.getSetting("update.auto", true) !== false && updater.check().catch(() => {});
      later(autoCheck, 8000);
      later(autoCheck, 6 * 60 * 60 * 1000, true);
    }
  }

  // detach: terminals stay in the pty daemon for the next start to adopt (a
  // restart or reload); otherwise they close. lost: another JAgents has the
  // data now, so nothing is saved. The database closes and no timer, hub
  // request, page watcher or module-level hook of this backend is left.
  function stop(o) {
    if (stopping) return stopping;
    stopped = true;
    const lost = Boolean(o && o.lost);
    stopping = (async () => {
      // A start still running finishes first, so all of it is undone.
      if (starting) await starting.catch(() => {});
      for (const t of timers) clearTimeout(t);
      timers.clear();
      for (const off of pages) off();
      pages.clear();
      windowHealth = null;
      try {
        if (acp) acp.stopAll({ save: !lost });
        if (plugins) plugins.stop();
        if (usage) usage.stop();
        if (hub) hub.stop();
        if (workspace) workspace.flush(!lost);
      } catch (error) {
        log("stopping: " + (error.message || error));
      }
      // Hold the stop until the daemon has the message.
      if (ptyHost) await (o && o.detach ? ptyHost.detach() : ptyHost.shutdown());
      setChildEnv(null);
      setExtraAgents(null);
      if (db) db.close();
    })();
    return stopping;
  }

  // The page's webContents (the window's, or a view's): keeps it from
  // staying blank, and binds the safe-mode key. Returns an undo.
  function onPage(wc) {
    const health = watchWindow(wc, { log });
    windowHealth = health;
    // Safe mode: if a plugin breaks the window, Ctrl+Shift+F12 turns every plugin off and reloads.
    const keys = (event, input) => {
      if (input.type === "keyDown" && input.key === "F12" && input.control && input.shift) {
        event.preventDefault();
        if (plugins) plugins.setSafeMode(true);
        wc.reload();
      }
    };
    wc.on("before-input-event", keys);
    const off = () => {
      pages.delete(off);
      health.dispose();
      if (windowHealth === health) windowHealth = null;
      if (!wc.isDestroyed()) {
        wc.removeListener("before-input-event", keys);
        wc.removeListener("destroyed", off);
      }
    };
    pages.add(off);
    wc.once("destroyed", off);
    return off;
  }

  // A dead GPU process can leave the page blank until it repaints.
  function childProcessGone(details) {
    if (details.type !== "GPU") return;
    if (windowHealth && !stopped) windowHealth.recover("GPU process gone (" + details.reason + ")");
    else log("GPU process gone (" + details.reason + ")");
  }

  return { serve, start, stop, onPage, openProject, childProcessGone, log, theme: () => theme(), running: () => started && !stopped, daemonPid: () => (ptyHost ? ptyHost.daemonPid : 0) };
}

module.exports = { createBackend, TITLEBAR_H };
