"use strict";

// Keeps the JAgents window from staying blank. A window goes blank when its
// page process dies, the GPU process dies (more likely with two JAgents
// running, or in remote and sandboxed sessions), the page fails to load, or
// the page never finishes starting. Each of those reloads the window, at most
// three times a minute, and is written to jagents.log in the data folder so
// the cause can be found afterwards.

const fs = require("node:fs");

const LOG_MAX = 1024 * 1024;
const RELOADS_PER_MINUTE = 3;

// print: where each line also goes (console.log unless given; null for none).
function createLog(file, print) {
  const echo = print === undefined ? (text) => console.log(text) : print;
  return (text) => {
    if (echo) echo(text);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + ".old");
      fs.appendFileSync(file, new Date().toISOString() + " [" + process.pid + "] " + text + "\n");
    } catch {
      /* logging must never break the app */
    }
  };
}

// readyMs: how long the page may take from starting to load until it reports
// ready (window.jagents.ready()) before it counts as stuck. target is the
// window or the page's webContents (a view inside another app's window).
// dispose() stops watching.
function watchWindow(target, { log, readyMs }) {
  const wc = target.webContents || target;
  const limit = readyMs || 20000;
  let reloads = [];
  let ready = false;
  let timer = null;
  let killTimer = null;
  let failTimer = null;
  let killing = false;

  // hard: the page is frozen and cannot let a reload through, so its process
  // is ended first and the reload starts a new one.
  function recover(reason, hard) {
    if (wc.isDestroyed()) return;
    const now = Date.now();
    reloads = reloads.filter((t) => now - t < 60000);
    if (reloads.length >= RELOADS_PER_MINUTE) {
      log("window: " + reason + "; not reloading again, it reloaded " + RELOADS_PER_MINUTE + " times this minute");
      return;
    }
    reloads.push(now);
    log("window: " + reason + "; " + (hard ? "restarting the page process" : "reloading"));
    ready = false;
    if (!hard) return wc.reload();
    // Reload once the old process is gone; a reload sent while it is still
    // dying is dropped and leaves the window with no page at all.
    killing = true;
    wc.forcefullyCrashRenderer();
    killTimer = setTimeout(() => {
      if (!killing || wc.isDestroyed()) return;
      killing = false;
      wc.reload();
    }, 3000);
  }

  const on = {
    "render-process-gone": (_event, details) => {
      if (killing) {
        killing = false;
        wc.reload();
        return;
      }
      recover("page process gone (" + details.reason + (details.exitCode ? ", code " + details.exitCode : "") + ")");
    },
    "did-fail-load": (_event, code, description, url, isMainFrame) => {
      // -3 is an aborted load (a reload replacing it), not a failure.
      if (isMainFrame && code !== -3) failTimer = setTimeout(() => recover("load failed (" + description + ", " + url + ")"), 1000);
    },
    unresponsive: () => log("window: page not responding"),
    responsive: () => log("window: page responding again"),
    "did-start-loading": () => {
      ready = false;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!ready) recover("page did not finish starting within " + Math.round(limit / 1000) + "s", true);
      }, limit);
    },
    destroyed: () => dispose(),
  };
  for (const [name, fn] of Object.entries(on)) wc.on(name, fn);

  function dispose() {
    for (const t of [timer, killTimer, failTimer]) clearTimeout(t);
    killing = false;
    if (!wc.isDestroyed()) for (const [name, fn] of Object.entries(on)) wc.removeListener(name, fn);
  }

  return {
    ready() {
      ready = true;
      clearTimeout(timer);
    },
    recover,
    dispose,
  };
}

module.exports = { createLog, watchWindow };
