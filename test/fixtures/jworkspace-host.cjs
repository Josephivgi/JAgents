"use strict";

// Loads electron/jworkspace.cjs the way JWorkspace does, in a hidden Electron
// process with a hand-built ctx: a show:false window, a host View over its
// stage and an offscreen page view with JAgents' preload. Checks the owner
// guard, a close while it starts, activate, a reload in place, a desktop
// build without the lock taking the terminals, and deactivate, and that
// process.env is not changed. ctx.isolated is set, so JAgents keeps its data in the scratch
// folder; nothing outside it is touched.
//
//   electron.exe test/fixtures/jworkspace-host.cjs --scratch=<folder>
//
// --not-isolated runs it as a real JWorkspace would (the desktop app's
// folders), which this check only allows with JAGENTS_DATA_ROOT and
// JAGENTS_HOME pointing at scratch folders.
//
// Prints one line of JSON and exits.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, WebContentsView, View, protocol, session, nativeTheme, webContents } = require("electron");

const ROOT = path.join(__dirname, "..", "..");
const arg = process.argv.find((a) => a.startsWith("--scratch="));
if (!arg) {
  process.stdout.write(JSON.stringify({ ok: false, error: "Pass --scratch=<folder>." }) + "\n");
  process.exit(2);
}
const SCRATCH = path.resolve(arg.slice("--scratch=".length));
const ISOLATED = !process.argv.includes("--not-isolated");
if (!ISOLATED && !(process.env.JAGENTS_DATA_ROOT && process.env.JAGENTS_HOME)) {
  process.stdout.write(JSON.stringify({ ok: false, error: "--not-isolated needs JAGENTS_DATA_ROOT and JAGENTS_HOME set to scratch folders." }) + "\n");
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "jworkspace.json"), "utf8"));

app.setPath("userData", path.join(SCRATCH, "electron"));
app.disableHardwareAcceleration();
for (const [name, value] of Object.entries(manifest.switches || {})) app.commandLine.appendSwitch(name, String(value));
protocol.registerSchemesAsPrivileged(manifest.schemes.map((s) => ({ scheme: s.scheme, privileges: s.privileges })));

const out = { ok: false, isolated: ISOLATED, steps: {} };
const children = [];
let finished = false;
function finish(extra) {
  if (finished) return;
  finished = true;
  Object.assign(out, extra);
  for (const c of children) if (c.exitCode === null) c.kill();
  process.stdout.write(JSON.stringify(out) + "\n");
  app.exit(out.ok ? 0 : 1);
}
process.on("uncaughtException", (e) => finish({ ok: false, error: String((e && e.stack) || e) }));
process.on("unhandledRejection", (e) => finish({ ok: false, error: String((e && e.stack) || e) }));
setTimeout(() => finish({ ok: false, error: "The check took over 4 minutes." }), 240000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for a desktop build without the owner lock (JAgents 0.6.5): its
// hub answers with the token it writes to hub.json and, given a pipe, it
// connects to the pty daemon there, which drops the app it had.
const OLD_JAGENTS = [
  "const net = require('net'), http = require('http'), fs = require('fs');",
  "const [hubFile, pipe] = process.argv.slice(1);",
  "const token = 'old-' + process.pid;",
  "const srv = http.createServer((q, s) => { s.writeHead(q.headers.authorization === 'Bearer ' + token ? 200 : 401); s.end('{}'); });",
  "srv.listen(0, '127.0.0.1', () => {",
  "  fs.writeFileSync(hubFile, JSON.stringify({ port: srv.address().port, token, pid: process.pid }));",
  "  if (!pipe) return console.log('ready');",
  "  const c = net.connect(pipe, () => console.log('ready'));",
  "  c.on('error', () => {});",
  "  c.resume();",
  "});",
].join("\n");
function oldJagents(homeDir, pipe) {
  const child = spawn(process.execPath, ["-e", OLD_JAGENTS, path.join(homeDir, "hub.json"), pipe], { env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }), stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.stdout.once("data", () => resolve(child));
    child.once("exit", () => reject(new Error("The stand-in JAgents exited.")));
  });
}
const ended = (child) => new Promise((r) => (child.exitCode === null && child.signalCode === null ? child.once("exit", r) : r()));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Keys added, removed or changed in process.env since `before`.
function envDiff(before) {
  const now = Object.assign({}, process.env);
  const keys = new Set(Object.keys(before).concat(Object.keys(now)));
  return Array.from(keys).filter((k) => before[k] !== now[k]).sort();
}

app.whenReady().then(async () => {
  const envBefore = Object.assign({}, process.env);
  const partition = "persist:app-" + manifest.id;
  const ses = session.fromPartition(partition);
  const win = new BrowserWindow({ show: false, width: 1400, height: 900 });
  const host = new View();
  win.contentView.addChildView(host);
  host.setBounds({ x: 236, y: 52, width: 1164, height: 848 });
  const page = new WebContentsView({ webPreferences: { partition, preload: path.join(ROOT, manifest.preload), contextIsolation: true, sandbox: true, nodeIntegration: false, offscreen: true } });
  host.addChildView(page);
  page.setBounds({ x: 0, y: 0, width: 1164, height: 848 });
  const wc = page.webContents;
  const dataDir = path.join(SCRATCH, "app-data", manifest.id);
  const dataRoot = ISOLATED ? path.join(dataDir, "data") : path.resolve(process.env.JAGENTS_DATA_ROOT);
  const homeDir = ISOLATED ? path.join(dataDir, "home") : path.resolve(process.env.JAGENTS_HOME);
  const logFile = path.join(SCRATCH, "logs", manifest.id + ".log");
  const mainFile = path.join(ROOT, manifest.main);
  let mod = require(mainFile);
  const shows = [];
  const reloads = []; // { done, error } per ctx.reload()
  const themeBefore = nativeTheme.themeSource;

  const ready = () => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("The page did not report ready in 30s.")), 30000);
    wc.ipc.once("app-ready", () => {
      clearTimeout(t);
      resolve();
    });
  });
  const run = (code) => wc.executeJavaScript(code, true);

  // What the app registered on its page and session, taken back after every
  // deactivate and failed activate, as JWorkspace does.
  let hooks = { handles: [], listeners: [], schemes: [] };
  const unhook = () => {
    if (!wc.isDestroyed()) {
      for (const name of hooks.handles) wc.ipc.removeHandler(name);
      for (const [name, fn] of hooks.listeners) wc.ipc.removeListener(name, fn);
    }
    for (const s of hooks.schemes) if (ses.protocol.isProtocolHandled(s)) ses.protocol.unhandle(s);
    hooks = { handles: [], listeners: [], schemes: [] };
  };
  const activate = () => mod.activate(ctx).catch((e) => {
    unhook();
    throw e;
  });
  const deactivate = async (reason) => {
    await mod.deactivate({ reason });
    unhook();
  };

  const ctx = {
    id: manifest.id,
    dir: ROOT,
    smoke: true,
    isolated: ISOLATED,
    session: ses,
    dataDir,
    handle() {
      throw new Error("JAgents Desktop answers through ctx.ipc.");
    },
    send: (channel, ...args) => !wc.isDestroyed() && wc.send(channel, ...args),
    protocol: {
      handle(scheme, fn) {
        if (!manifest.schemes.some((s) => s.scheme === scheme)) throw new Error("Undeclared scheme " + scheme);
        if (ses.protocol.isProtocolHandled(scheme)) ses.protocol.unhandle(scheme);
        ses.protocol.handle(scheme, fn);
        if (!hooks.schemes.includes(scheme)) hooks.schemes.push(scheme);
      },
    },
    theme: { get: () => "system", set() {} },
    ipc: {
      handle(name, fn) {
        wc.ipc.handle(name, fn);
        hooks.handles.push(name);
      },
      on(name, fn) {
        wc.ipc.on(name, fn);
        hooks.listeners.push([name, fn]);
      },
    },
    window: () => win,
    surface: () => ({ contentView: host, webContents: wc }),
    async reload() {
      const rec = { done: false, error: "" };
      reloads.push(rec);
      try {
        await deactivate("reload");
        for (const key of Object.keys(require.cache)) if (key.startsWith(ROOT + path.sep) && !key.includes(path.sep + "node_modules" + path.sep)) delete require.cache[key];
        mod = require(mainFile);
        await activate();
        const r = ready();
        wc.reload();
        await r;
      } catch (e) {
        rec.error = e.message;
        throw e;
      } finally {
        rec.done = true;
      }
    },
    show: () => shows.push(Date.now()),
    log: (text) => {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.appendFileSync(logFile, new Date().toISOString() + " " + text + "\n");
    },
  };

  // 1. The owner guard: the lock held by a desktop app, then a running JAgents
  // named in the hub file (a desktop build without the lock).
  {
    const ownerLock = require(path.join(ROOT, "electron", "owner-lock.cjs"));
    const lock = await ownerLock.acquire({ dataRoot, host: "desktop" });
    let lockRefused = "";
    await activate().catch((e) => (lockRefused = e.message));
    lock.release();
    // An electron.exe that stands for a development JAgents: its hub answers
    // with the token it wrote to hub.json.
    fs.mkdirSync(homeDir, { recursive: true });
    const fake = await oldJagents(homeDir, "");
    let hubRefused = "";
    await activate().catch((e) => (hubRefused = e.message));
    fake.kill();
    await ended(fake);
    // What it leaves behind (a crash or a kill): a hub file nobody answers.
    // That alone refuses nothing; the start below would fail here otherwise.
    const staleHub = fs.existsSync(path.join(homeDir, "hub.json"));
    const free = await ownerLock.acquire({ dataRoot, host: "desktop" });
    out.steps.guard = { lockRefused, hubRefused, staleHub, lockFreeAfter: free.held, handlersLeft: ses.protocol.isProtocolHandled("jagents-app") };
    free.release();
  }

  // 1b. Closed while starting: right away (during the lock), and a moment
  // later (during the backend's start). Either way nothing stays behind.
  {
    const ownerLock = require(path.join(ROOT, "electron", "owner-lock.cjs"));
    const daemonPids = () => {
      try {
        return Array.from(fs.readFileSync(path.join(dataRoot, "pty-daemon.log"), "utf8").matchAll(/\[(\d+)\] listening on/g), (m) => Number(m[1]));
      } catch {
        return [];
      }
    };
    const cancel = async (ms) => {
      let result = "activated";
      const starting = activate().catch((e) => (result = e.message));
      if (ms) await sleep(ms);
      await deactivate("close");
      await starting;
      await sleep(1000);
      const free = await ownerLock.acquire({ dataRoot, host: "desktop" });
      free.release();
      return { result, lockFree: free.held, schemeGone: !ses.protocol.isProtocolHandled("jagents-app"), daemonsLeft: daemonPids().filter(alive).length };
    };
    out.steps.cancel = { atOnce: await cancel(0), later: await cancel(400) };
  }

  // 2. Activate, load the page from the app's scheme, drive it.
  await activate();
  let r = ready();
  await wc.loadURL(manifest.url);
  await r;
  const pageCheck = await run(fs.readFileSync(path.join(__dirname, "page-check.js"), "utf8"));
  const titlebar = await run('window.jagents.titlebarColors({ color: "#ffffff", symbolColor: "#000000" })');
  const update = await run("window.jagents.updates.apply().then(() => 'applied', (e) => String(e.message || e))");
  // The built-in browser: its view goes in the host view and its cookies in the data folder.
  await run('window.jagents.plugins.invoke("browser", "attach", { pane: "check-browser", url: "about:blank" })');
  const browserWc = webContents.getAllWebContents().find((w) => w !== wc && w.session !== ses && w.session.storagePath && w.session.storagePath.toLowerCase().includes("jagents-browser"));
  const browser = { fromPath: typeof session.fromPath === "function", storage: browserWc ? browserWc.session.storagePath : "", inHost: host.children.length > 1 };
  await run('window.jagents.plugins.invoke("browser", "sync", { panes: [] })');
  browser.removed = host.children.length === 1;
  out.steps.activate = { page: pageCheck, titlebar, themeKept: nativeTheme.themeSource === themeBefore, update, browser, hubFile: fs.existsSync(path.join(homeDir, "hub.json")) };

  // 3. Reload in place: a running terminal stays in the pty daemon and the
  // new backend adopts it.
  const keep = await run('window.jagents.panes.addTerminal({ provider: "shell", cwd: ' + JSON.stringify(dataRoot) + ', title: "Keep", size: { cols: 120, rows: 30 } }).then((p) => p.id)');
  await sleep(1500);
  await ctx.reload();
  const after = await run("(async () => { const list = await window.jagents.panes.list(); const snap = await window.jagents.pty.attach(" + JSON.stringify(keep) + ", { cols: 120, rows: 30 }); const info = await window.jagents.appInfo(); return { listed: list.some((p) => p.id === " + JSON.stringify(keep) + "), exited: snap ? snap.exited : null, host: info.host }; })()");
  const daemonLog = fs.readFileSync(path.join(dataRoot, "pty-daemon.log"), "utf8");
  out.steps.reload = Object.assign(after, { kept: /app restarting; 1 terminals stay open/.test(daemonLog), adopted: /app connected; 1 terminals/.test(daemonLog) });

  // 3b. A desktop build without the owner lock opens the same data: it
  // connects to the pty daemon, which drops this app. The backend stops
  // without saving and reloads, and the reload refuses while that build's
  // hub answers. Once it is gone a start works again and adopts the terminal.
  {
    const { pipePath } = require(path.join(ROOT, "electron", "pty-client.cjs"));
    const n = reloads.length;
    const old = await oldJagents(homeDir, pipePath(dataRoot));
    const end = Date.now() + 30000;
    while (Date.now() < end && !(reloads.length > n && reloads[reloads.length - 1].done)) await sleep(100);
    const refused = reloads.length > n ? reloads[reloads.length - 1].error : "no reload";
    const jlog = fs.readFileSync(path.join(dataRoot, "jagents.log"), "utf8");
    old.kill();
    await ended(old);
    await activate();
    const r2 = ready();
    wc.reload();
    await r2;
    const again = await run("(async () => { const snap = await window.jagents.pty.attach(" + JSON.stringify(keep) + ", { cols: 120, rows: 30 }); const info = await window.jagents.appInfo(); return { exited: snap ? snap.exited : null, host: info.host }; })()");
    out.steps.takeover = Object.assign({ refused, lostLogged: /lost the terminal service/.test(jlog) }, again);
  }

  // 4. Deactivate: terminals close, the daemon exits, the hub file goes, the
  // database closes, the page's channels and the scheme go. The lock stays:
  // the browser's shared storage was opened in this process (step 2), and a
  // desktop app asking to come forward is told to quit JWorkspace first.
  const daemonPid = Number((Array.from(daemonLog.matchAll(/\[(\d+)\] listening on/g)).pop() || [])[1]) || 0;
  await deactivate("close");
  await sleep(1500);
  let dbClosed = false;
  try {
    fs.renameSync(path.join(dataRoot, "jagents.db"), path.join(dataRoot, "jagents-closed.db"));
    fs.renameSync(path.join(dataRoot, "jagents-closed.db"), path.join(dataRoot, "jagents.db"));
    dbClosed = true;
  } catch {
    dbClosed = false;
  }
  const ipcGone = await run("window.jagents.appInfo().then(() => 'answered', (e) => String(e.message || e))");
  const ownerLock = require(path.join(ROOT, "electron", "owner-lock.cjs"));
  const free = await ownerLock.acquire({ dataRoot, host: "desktop" });
  const keptAnswer = free.held ? "" : await free.ask("show", { argv: [] }).then((a) => String(a.error || ""), (e) => String(e.message || e));
  out.steps.deactivate = { daemonPid, daemonGone: daemonPid > 0 && !alive(daemonPid), hubFileGone: !fs.existsSync(path.join(homeDir, "hub.json")), dbClosed, ipcGone, schemeGone: !ses.protocol.isProtocolHandled("jagents-app"), lockKept: !free.held && Boolean(free.owner) && free.owner.pid === process.pid, keptAnswer };
  if (free.held) free.release();

  out.envChanged = envDiff(envBefore);
  out.envUnchanged = out.envChanged.length === 0;
  out.claudecodeStillSet = process.env.CLAUDECODE || "";
  out.shown = win.isVisible();
  out.shows = shows.length;
  const g = out.steps.guard;
  const a = out.steps.activate;
  const rl = out.steps.reload;
  const d = out.steps.deactivate;
  const t = out.steps.takeover;
  const c = out.steps.cancel;
  const cancelled = (x) => (x.result === "JAgents Desktop was closed while it was starting." || x.result === "activated") && x.lockFree && x.schemeGone && x.daemonsLeft === 0;
  out.ok = Boolean(
    cancelled(c.atOnce) && c.atOnce.result !== "activated" && cancelled(c.later) &&
    g.lockRefused === "JAgents Desktop is open in its own window. Close it, then press Reload." && g.hubRefused === g.lockRefused && g.staleHub && g.lockFreeAfter && !g.handlersLeft &&
      a.page && a.page.ok && a.page.host === "jworkspace" && path.resolve(a.page.dataRoot) === path.resolve(dataRoot) && a.titlebar === false && a.themeKept && /Updates come from that folder/.test(a.update) && a.hubFile &&
      a.browser.fromPath && path.resolve(a.browser.storage || ".") === path.join(dataRoot, "Partitions", "jagents-browser") && a.browser.inHost && a.browser.removed &&
      rl.listed && rl.exited === false && rl.host === "jworkspace" && rl.kept && rl.adopted &&
      t.refused === g.lockRefused && t.lostLogged && t.exited === false && t.host === "jworkspace" &&
      d.daemonGone && d.hubFileGone && d.dbClosed && /No handler registered/.test(d.ipcGone) && d.schemeGone && d.lockKept && /Quit JWorkspace/.test(d.keptAnswer) &&
      out.envUnchanged && !out.shown,
  );
  finish({});
});
