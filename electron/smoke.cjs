"use strict";

// The desktop app's hidden test run (main.cjs --smoke). The window stays
// hidden; once the page reports ready, test/fixtures/page-check.js runs in it
// (app-info and a terminal round trip through the real pty daemon). One line
// of JSON goes to stdout, then the app quits, which closes the daemon.

const fs = require("node:fs");
const path = require("node:path");
const { ipcMain, webContents, dialog, shell } = require("electron");

const LIMIT_MS = 90000;

// A hidden run never shows a native dialog (one with a hidden parent window
// still shows on the desktop and waits for a click) and never opens a
// browser or Explorer window. Each is answered as cancelled and listed in
// the returned array, which the JSON reports.
function quietDialogs() {
  const calls = [];
  const note = (what, args) => {
    const o = args.find((a) => a && typeof a === "object" && !a.webContents) || {};
    calls.push(what + (o.message || o.title ? ": " + (o.message || o.title) : typeof args[0] === "string" ? ": " + args[0] : ""));
    return o;
  };
  // The dialog's own Cancel: its cancelId, else a Cancel or No button, else
  // no button at all.
  const cancel = (o) => {
    if (typeof o.cancelId === "number") return o.cancelId;
    const i = (o.buttons || []).findIndex((b) => /^(cancel|no)$/i.test(String(b)));
    return i >= 0 ? i : -1;
  };
  dialog.showMessageBox = async (...args) => ({ response: cancel(note("showMessageBox", args)), checkboxChecked: false });
  dialog.showMessageBoxSync = (...args) => cancel(note("showMessageBoxSync", args));
  dialog.showOpenDialog = async (...args) => (note("showOpenDialog", args), { canceled: true, filePaths: [] });
  dialog.showOpenDialogSync = (...args) => void note("showOpenDialogSync", args);
  dialog.showSaveDialog = async (...args) => (note("showSaveDialog", args), { canceled: true, filePath: "" });
  dialog.showSaveDialogSync = (...args) => void note("showSaveDialogSync", args);
  dialog.showErrorBox = (...args) => void note("showErrorBox", args);
  shell.openExternal = async (...args) => void note("openExternal", args);
  shell.openPath = async (...args) => (note("openPath", args), "");
  shell.showItemInFolder = (...args) => void note("showItemInFolder", args);
  return calls;
}

function within(promise, ms, what) {
  let timer = null;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(what + " did not happen within " + ms / 1000 + "s.")), ms)))]).finally(() => clearTimeout(timer));
}

async function run({ win, backend, dataRoot, dialogs }) {
  const out = { ok: false };
  try {
    await within(new Promise((resolve) => ipcMain.once("app-ready", resolve)), 30000, "The page reporting ready");
    const script = fs.readFileSync(path.join(__dirname, "..", "test", "fixtures", "page-check.js"), "utf8");
    const page = await within(win.webContents.executeJavaScript(script, true), LIMIT_MS, "The page check");
    // JAGENTS_SMOKE_EXTRA: a second page script (a file whose value is a promise)
    // for one-off checks, such as a real agent calling an MCP tool. Its result is out.extra.
    if (process.env.JAGENTS_SMOKE_EXTRA) out.extra = await within(win.webContents.executeJavaScript(fs.readFileSync(process.env.JAGENTS_SMOKE_EXTRA, "utf8"), true), 240000, "The extra page check");
    // The built-in browser keeps its cookies in <data folder>\Partitions\jagents-browser.
    await win.webContents.executeJavaScript('window.jagents.plugins.invoke("browser", "attach", { pane: "smoke-browser", url: "about:blank" })', true);
    const view = webContents.getAllWebContents().find((w) => w !== win.webContents && /jagents-browser$/i.test(w.session.storagePath || ""));
    const browserStorage = view ? view.session.storagePath : "";
    await win.webContents.executeJavaScript('window.jagents.plugins.invoke("browser", "sync", { panes: [] })', true);
    // Saves the page queued after closing the pane (it waits 200 ms) land before the quit.
    await new Promise((r) => setTimeout(r, 500));
    Object.assign(out, {
      ok: Boolean(page && page.ok) && page.host === "desktop" && path.resolve(page.dataRoot) === path.resolve(dataRoot) && path.resolve(browserStorage || ".") === path.join(path.resolve(dataRoot), "Partitions", "jagents-browser"),
      page,
      browserStorage,
      daemonPid: backend.daemonPid(),
      hubFile: fs.existsSync(path.join(page.hubDir, "hub.json")),
      shown: win.isVisible(),
      // Native dialogs and outside windows the run asked for; the check asks for none.
      dialogs: dialogs || [],
    });
    if (out.dialogs.length) out.ok = false;
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  process.stdout.write(JSON.stringify(out) + "\n");
  // --smoke-hold=<ms> (60 s at most): stay open, still owning the data folder,
  // so a test can try a second JAgents on it meanwhile.
  const hold = Math.min(60000, Number((process.argv.find((a) => a.startsWith("--smoke-hold=")) || "").slice("--smoke-hold=".length)) || 0);
  if (hold > 0) await new Promise((r) => setTimeout(r, hold));
  return out;
}

module.exports = { run, quietDialogs };
