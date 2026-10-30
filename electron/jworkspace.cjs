"use strict";

// JAgents Desktop as a JWorkspace app. JWorkspace reads jworkspace.json, loads
// the same page (renderer/ and preload.cjs) in a view of its window, and calls
// activate() in its main process with a context for that view. The backend is
// the desktop app's (backend.cjs); the page's IPC goes to the view only.
//
// Data: the desktop app's folders (%APPDATA%\JAgents and ~/.jagents, or
// JAGENTS_DATA_ROOT and JAGENTS_HOME), with one JAgents at a time on them.
// When the desktop app has them open, activate fails with a plain message.
// When a desktop build without the owner lock opens them later and takes the
// terminals, this one stops without saving and reloads, which then refuses
// with the same message. JWorkspace's hidden and scratch runs (ctx.isolated)
// use folders in ctx.dataDir instead. JWorkspace's process.env is never changed.
//
// Inside JWorkspace: no window buttons or theme changes, updates are not
// installed from here, a restart reloads JAgents in place, Auto MCP is off in
// isolated and smoke runs, and notifications are off in smoke runs.

const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");
const { cleanEnv } = require("../lib/child-env");
const { createBackend } = require("./backend.cjs");
const ownerLock = require("./owner-lock.cjs");

const SCHEME = "jagents-app";
const OPEN_IN_DESKTOP = "JAgents Desktop is open in its own window. Close it, then press Reload.";
const OPEN_IN_JWORKSPACE = "JAgents Desktop is open in another JWorkspace. Close it there, then press Reload.";
// The answer to a desktop app asking to come forward while no start runs
// here but the data folder stays claimed for its browser storage.
const KEPT = "JAgents Desktop ran inside JWorkspace, which keeps its browser data open until it quits. Quit JWorkspace, then open JAgents again.";

let current = null;

// Owner locks this process holds, by data folder: { lock, owner }, where
// owner is the start that runs on it, or null between starts. Kept on the
// process, not this module, because a reload loads this module again.
function claims() {
  const key = Symbol.for("jagents.jworkspace.claims");
  if (!globalThis[key]) globalThis[key] = new Map();
  return globalThis[key];
}
const claimKey = (dataRoot) => path.resolve(dataRoot).toLowerCase();

// The built-in browser marks a data folder once a page here used its
// storage (builtin/browser/main.cjs). That storage stays open until this
// process exits, so the lock stays too.
function browserOpen(key) {
  const set = globalThis[Symbol.for("jagents.sharedBrowser")];
  return Boolean(set && set.has(key));
}

// Another JAgents asked this one to come forward (a second launch of the
// desktop app): the running start shows its page.
function showOwner(key, argv) {
  const claim = claims().get(key);
  const state = claim && claim.owner;
  if (!state || state.stopped) throw new Error(KEPT);
  state.ctx.show();
  if (state.backend) state.backend.openProject(argv);
}

function folders(ctx) {
  if (ctx.isolated) return { dataRoot: path.join(ctx.dataDir, "data"), homeDir: path.join(ctx.dataDir, "home"), legacy: { on: false, root: "" } };
  const legacyRoot = process.env.JAGENTS_LEGACY_ROOT || "";
  return {
    dataRoot: process.env.JAGENTS_DATA_ROOT ? path.resolve(process.env.JAGENTS_DATA_ROOT) : path.join(app.getPath("appData"), "JAgents"),
    homeDir: process.env.JAGENTS_HOME ? path.resolve(process.env.JAGENTS_HOME) : path.join(os.homedir(), ".jagents"),
    legacy: { on: Boolean(legacyRoot || !process.env.JAGENTS_DATA_ROOT), root: legacyRoot },
  };
}

// The owner lock: { held, owner }. A claim this process already has is used
// again once the start that had it is done (a reload whose stop ran past
// JWorkspace's wait lets go shortly).
async function takeLock(state) {
  let owner = { host: "jworkspace", pid: process.pid };
  for (let i = 0; ; i++) {
    const claim = claims().get(state.key);
    if (claim && !claim.owner) {
      claim.owner = state;
      state.claim = claim;
      return { held: true, owner: null };
    }
    if (!claim) {
      const lock = await ownerLock.acquire({ dataRoot: state.dataRoot, host: "jworkspace", onShow: (argv) => showOwner(state.key, argv) });
      if (lock.held) {
        state.claim = { lock, owner: state };
        claims().set(state.key, state.claim);
        return { held: true, owner: null };
      }
      if (!lock.owner || lock.owner.pid !== process.pid) return { held: false, owner: lock.owner };
      owner = lock.owner;
    }
    if (i >= 40 || state.stopped) return { held: false, owner };
    await new Promise((r) => setTimeout(r, 250));
  }
}

// A start is done with the data folder: the lock goes, unless the shared
// browser storage is open in this process.
function letGo(state) {
  const claim = state.claim;
  state.claim = null;
  if (!claim || claim.owner !== state) return;
  claim.owner = null;
  if (browserOpen(state.key)) return;
  claims().delete(state.key);
  claim.lock.release();
}

async function activate(ctx) {
  if (typeof ctx.surface !== "function" || !ctx.ipc) throw new Error("This JWorkspace cannot run JAgents Desktop yet. Update JWorkspace, then press Reload.");
  if (current) await deactivate({ reason: "reload" });
  const { dataRoot, homeDir, legacy } = folders(ctx);
  const page = ctx.surface().webContents;
  if (!page) throw new Error("JAgents Desktop's page closed while it was starting.");
  const state = { ctx, page, dataRoot, key: claimKey(dataRoot), backend: null, claim: null, listeners: [], gpuGone: null, stopped: false, done: null };
  current = state;
  // A deactivate while this runs (JWorkspace closed or reloaded it) stops here.
  const still = () => {
    if (state.stopped) throw new Error("JAgents Desktop was closed while it was starting.");
  };
  try {
    // The owner lock first, then desktop builds that do not have it; nothing
    // touches the pty daemon or the database before both pass.
    const lock = await takeLock(state);
    if (!lock.held) throw new Error(lock.owner && lock.owner.host === "jworkspace" ? OPEN_IN_JWORKSPACE : OPEN_IN_DESKTOP);
    still();
    const other = await ownerLock.otherOwner({ dataRoot, homeDir, isolated: Boolean(ctx.isolated) });
    if (other) {
      ctx.log("not starting: " + other.why + " (pid " + other.pid + ") on " + dataRoot);
      throw new Error(OPEN_IN_DESKTOP);
    }
    still();
    state.backend = createBackend({
      dataRoot,
      homeDir,
      host: "jworkspace",
      smoke: Boolean(ctx.smoke),
      // Programs JAgents starts get JWorkspace's environment without a Claude
      // Code session's markers; JWorkspace's own stays as it is.
      env: cleanEnv(process.env),
      legacy,
      argv: [],
      // Raw like ipcMain: the preload expects plain values and rejections. A
      // handler left on the page by a host that did not remove it is replaced;
      // a stopped start registers nothing.
      handle: (name, fn) => {
        if (state.stopped) return;
        if (!page.isDestroyed()) page.ipc.removeHandler(name);
        ctx.ipc.handle(name, fn);
      },
      on: (name, fn) => {
        if (state.stopped) return;
        ctx.ipc.on(name, fn);
        state.listeners.push([name, fn]);
      },
      send: (channel, payload) => ctx.send(channel, payload),
      getWindow: () => ctx.window(),
      surface: () => ctx.surface(),
      restart: () => ctx.reload(),
      focus: () => ctx.show(),
      // Another JAgents took the terminals and the backend stopped without
      // saving. The reload's start refuses while that JAgents runs.
      lost: () => {
        ctx.log("another JAgents took the terminals on " + dataRoot + "; reloading");
        Promise.resolve(ctx.reload()).catch(() => {});
      },
      print: (text) => ctx.log(text),
      features: { titlebar: false, autoMcp: !ctx.isolated && !ctx.smoke, updaterApply: false, notifications: !ctx.smoke },
    });
    ctx.protocol.handle(SCHEME, state.backend.serve);
    await state.backend.start();
    still();
    state.backend.onPage(page);
    state.gpuGone = (_event, details) => state.backend.childProcessGone(details);
    app.on("child-process-gone", state.gpuGone);
  } catch (error) {
    if (current === state) current = null;
    // A failed start keeps the terminals in the daemon for the next try.
    await cleanup(state, true);
    // A deactivate during the lock wait cleaned up before the lock came.
    letGo(state);
    throw error;
  }
}

// reason: "close", "reload", "remove" or "quit". A reload keeps the terminals
// running in the pty daemon for the next activate to adopt; the others close them.
async function deactivate(opts) {
  const state = current;
  current = null;
  if (state) await cleanup(state, Boolean(opts && opts.reason === "reload"));
}

// Runs once per start. The page's handlers and the scheme are JWorkspace's to
// remove (a late cleanup here could remove the next start's); this removes
// only its own listeners.
function cleanup(state, detach) {
  state.stopped = true;
  if (!state.done) {
    state.done = (async () => {
      if (state.gpuGone) app.removeListener("child-process-gone", state.gpuGone);
      try {
        if (state.backend) await state.backend.stop({ detach });
      } finally {
        if (!state.page.isDestroyed()) for (const [name, fn] of state.listeners) state.page.ipc.removeListener(name, fn);
        letGo(state);
      }
    })();
  }
  return state.done;
}

module.exports = { activate, deactivate };
