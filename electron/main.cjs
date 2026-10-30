"use strict";

// The JAgents desktop app: its own window around the backend (backend.cjs),
// which JWorkspace also loads (jworkspace.cjs). One JAgents runs per data
// folder: when JWorkspace already has it open, this asks JWorkspace to show
// its JAgents page and quits.
//
// --smoke: a hidden test run (smoke.cjs). It needs JAGENTS_DATA_ROOT and
// JAGENTS_HOME (or --data-root= and --jagents-home=) set to scratch folders,
// prints JSON and quits by itself. --smoke-hold=<ms> keeps it open (still
// owning its data folder) that much longer after the check.

// --data-root= and --jagents-home= do what JAGENTS_DATA_ROOT and JAGENTS_HOME
// do, for shortcuts that cannot set environment variables. Read before the
// modules below, which pick up JAGENTS_HOME when they load.
for (const arg of process.argv) {
  const m = /^--(data-root|jagents-home)=(.+)$/.exec(arg);
  if (m) process.env[m[1] === "data-root" ? "JAGENTS_DATA_ROOT" : "JAGENTS_HOME"] = m[2];
}

const path = require("node:path");
const { app, BrowserWindow, ipcMain, protocol, shell, nativeTheme, Menu, dialog } = require("electron");
const { cleanEnv } = require("../lib/child-env");
const { createBackend, TITLEBAR_H } = require("./backend.cjs");
const { HOME_DIR } = require("./hub.cjs");
const ownerLock = require("./owner-lock.cjs");
const { setupTaskbarIcon } = require("./win-taskbar.cjs");
const { createLog } = require("./window-health.cjs");

const APP_ROOT = path.join(__dirname, "..");
const SHELL_URL = "app://shell/index.html";
const SMOKE = process.argv.includes("--smoke");

// JAgents started from inside a Claude Code session or an agent shell drops
// that session's markers and colour-off switches (lib/child-env.js) for
// everything it starts.
{
  const clean = cleanEnv(process.env);
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
}

// A smoke run must never touch the real data. A crash in one is printed as
// JSON (no error box), the terminals are closed, and it exits. Native
// dialogs and outside windows are answered as cancelled (smoke.cjs).
let smokeStop = () => Promise.resolve();
const smokeDialogs = SMOKE ? require("./smoke.cjs").quietDialogs() : [];
if (SMOKE) {
  if (!(process.env.JAGENTS_DATA_ROOT && process.env.JAGENTS_HOME)) {
    process.stdout.write(JSON.stringify({ ok: false, error: "--smoke needs JAGENTS_DATA_ROOT and JAGENTS_HOME set to scratch folders." }) + "\n");
    process.exit(2);
  }
  const crash = (error) => {
    process.stdout.write(JSON.stringify({ ok: false, error: String((error && error.stack) || error) }) + "\n");
    Promise.race([smokeStop(), new Promise((r) => setTimeout(r, 5000))]).finally(() => app.exit(1));
  };
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  setTimeout(() => crash(new Error("The smoke run took over 2 minutes.")), 120000);
}

app.setName("JAgents");
// Some sandboxed or remote sessions crash the GPU process; this falls back to software rendering.
if (process.env.JAGENTS_DISABLE_GPU === "1" || SMOKE) app.disableHardwareAcceleration();
// Each terminal pane draws with its own WebGL context, and Chromium's default
// cap of 16 would drop the oldest ones in a big grid.
app.commandLine.appendSwitch("max-active-webgl-contexts", "64");
const DATA_ROOT = process.env.JAGENTS_DATA_ROOT ? path.resolve(process.env.JAGENTS_DATA_ROOT) : path.join(app.getPath("appData"), "JAgents");
// Before the rebrand the data folder was "Relay ADE"; copy it once.
// Relay ADE data comes in only when the user presses "Get data from legacy
// Relay" in MCP hub (lib/migrate.js). That leaves a flag file and restarts, so
// the import runs before the database opens. A test data root only sees Relay
// data when JAGENTS_LEGACY_ROOT names the folder.
const LEGACY_ROOT = process.env.JAGENTS_LEGACY_ROOT || "";
const LEGACY_ON = Boolean(LEGACY_ROOT || !process.env.JAGENTS_DATA_ROOT);
app.setPath("userData", DATA_ROOT);

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let taskbar = null;
let mainWindow = null;
let started = false;
let lock = null;
const log = createLog(path.join(DATA_ROOT, "jagents.log"));

const backend = createBackend({
  dataRoot: DATA_ROOT,
  homeDir: HOME_DIR,
  host: "desktop",
  smoke: SMOKE,
  argv: process.argv,
  legacy: { on: LEGACY_ON, root: LEGACY_ROOT },
  handle: (channel, fn) => ipcMain.handle(channel, fn),
  on: (channel, fn) => ipcMain.on(channel, fn),
  send: (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
  },
  getWindow: () => mainWindow,
  restart: restartApp,
  focus: () => showWindow([]),
  // Another JAgents (a build without the owner lock) took the terminals and
  // the backend stopped without saving; this one closes instead of running
  // on the same data.
  lost: () => {
    log("lost the terminals to another JAgents; closing");
    if (SMOKE || !mainWindow || mainWindow.isDestroyed()) return app.quit();
    dialog.showMessageBox(mainWindow, { type: "warning", buttons: ["Close"], message: "JAgents lost its terminals", detail: "Another JAgents opened this data folder, or the terminal service stopped. This window closes so the two do not overwrite each other's threads and panes. Open JAgents again once the other one is closed.", noLink: true }).finally(() => app.quit());
  },
  features: { titlebar: true, autoMcp: !SMOKE, updaterApply: true, notifications: !SMOKE },
});
smokeStop = () => backend.stop({ detach: false });

function createWindow() {
  // Windows draws a 1px frame line around the window in the system's light
  // or dark color; it follows the app's theme instead, or a light app showed
  // a dark line along its top.
  const theme = backend.theme();
  nativeTheme.themeSource = theme;
  started = true;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: !SMOKE,
    title: "JAgents",
    icon: path.join(APP_ROOT, "build", process.platform === "win32" ? "icon.ico" : "icon.png"),
    backgroundColor: theme === "dark" ? "#16181d" : "#f5f6f8",
    autoHideMenuBar: true,
    // No title bar: the tab strip is the title bar, and Windows draws its own
    // minimize, maximize and close buttons over its right end.
    titleBarStyle: "hidden",
    titleBarOverlay: { color: theme === "dark" ? "#111111" : "#ffffff", symbolColor: theme === "dark" ? "#d4d4d8" : "#3f3f46", height: TITLEBAR_H },
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
  // Blank-window recovery and the safe-mode key (Ctrl+Shift+F12).
  backend.onPage(mainWindow.webContents);
  mainWindow.loadURL(SHELL_URL);
  mainWindow.on("closed", () => (mainWindow = null));
}

// Terminals live in the pty daemon, so a restart leaves them running and the
// next app adopts them; a real quit closes them.
let restarting = false;
function restartApp() {
  restarting = true;
  app.relaunch();
  app.quit();
}

app.whenReady().then(async () => {
  // Electron's default menu is hidden but its shortcuts still ran: Ctrl+Shift+R
  // reloaded the window and Ctrl+Shift+I opened DevTools, keys a terminal
  // program may want.
  Menu.setApplicationMenu(null);
  // JAgents inside JWorkspace may have this data folder open; it shows its
  // JAgents page instead, and this one quits before touching the data.
  lock = await ownerLock.acquire({ dataRoot: DATA_ROOT, host: "desktop", onShow: (argv) => showWindow(argv) });
  if (!lock.held) {
    log("this data folder is open in " + (lock.owner ? lock.owner.host + " (pid " + lock.owner.pid + ")" : "another JAgents") + "; showing it there");
    const reply = await lock.ask("show", { argv: process.argv }).catch(() => null);
    const shown = Boolean(reply && reply.ok);
    if (SMOKE) process.stdout.write(JSON.stringify({ ok: false, error: "The data folder is open in another JAgents.", owner: lock.owner, shown, answer: (reply && reply.error) || "" }) + "\n");
    // The owner could not show JAgents (JWorkspace keeps the folder for its
    // browser data after JAgents Desktop stopped there): say why.
    else if (reply && !reply.ok && reply.error) await dialog.showMessageBox({ type: "info", buttons: ["OK"], message: "JAgents cannot open yet", detail: String(reply.error), noLink: true });
    app.quit();
    return;
  }
  protocol.handle("app", backend.serve);
  await backend.start();
  if (!SMOKE) {
    try {
      taskbar = setupTaskbarIcon({ app, shell, appRoot: APP_ROOT, icoPath: path.join(APP_ROOT, "build", "icon.ico"), customRoot: process.env.JAGENTS_DATA_ROOT ? DATA_ROOT : "", jagentsHome: process.env.JAGENTS_HOME ? HOME_DIR : "", log: (t) => console.log(t) });
    } catch (error) {
      console.error("Taskbar icon: " + error.message);
    }
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
  if (SMOKE) require("./smoke.cjs").run({ win: mainWindow, backend, dataRoot: DATA_ROOT, dialogs: smokeDialogs }).then(() => app.quit());
});

// Opening JAgents again shows the running one. Before startup finishes there
// is no window yet; it opens and comes forward on its own then.
function showWindow(argv) {
  backend.openProject(argv);
  if (SMOKE) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (started) createWindow();
    return;
  }
  if (mainWindow.webContents.isCrashed()) mainWindow.reload();
  if (mainWindow.isMinimized()) mainWindow.restore();
  // Windows keeps a background app from taking focus; topmost for a moment
  // brings the window over the terminal that asked for it.
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
  app.focus({ steal: true });
  mainWindow.setAlwaysOnTop(false);
}

app.on("second-instance", (_event, argv) => {
  log("second launch: showing the running window");
  showWindow(argv);
});

app.on("child-process-gone", (_event, details) => backend.childProcessGone(details));

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  quitting = true;
  if (!backend.running()) return;
  // Hold the quit until the daemon has the message.
  event.preventDefault();
  backend.stop({ detach: restarting }).finally(() => {
    if (lock) lock.release();
    app.quit();
  });
});

app.on("window-all-closed", () => app.quit());
