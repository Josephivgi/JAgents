"use strict";

// The app's side of the pty daemon (pty-daemon.cjs). connectPtyHost() reaches
// the daemon for this data folder, starting it when none is running, and
// returns a pty host with the same API as an in-process one: terminals still
// running from before a restart are adopted with their screens, and new ones
// are created in the daemon. detach() leaves them running for the next app;
// shutdown() closes them.
//
// The daemon serves one app at a time and drops the one it had when another
// connects. onLost() runs when the connection ends without detach() or
// shutdown(): another JAgents took the terminals (a build without the owner
// lock), or the daemon stopped.

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const { createPtyHost } = require("./pty-host.cjs");

const PROTOCOL = 1;

function pipePath(dataRoot) {
  const tag = createHash("sha1").update(path.resolve(dataRoot).toLowerCase()).digest("hex").slice(0, 12);
  return process.platform === "win32" ? "\\\\.\\pipe\\jagents-pty-" + tag : path.join(os.tmpdir(), "jagents-pty-" + tag + ".sock");
}

function connectOnce(pipe) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    const fail = (error) => {
      sock.destroy();
      reject(error);
    };
    sock.once("error", fail);
    sock.setTimeout(2000, () => fail(new Error("timeout")));
    sock.once("connect", () => {
      sock.removeListener("error", fail);
      sock.setTimeout(0);
      resolve(sock);
    });
  });
}

// env: the base environment for the daemon and so for every terminal it
// starts (a cleaned copy when JAgents runs inside another app).
function startDaemon(pipe, logFile, env) {
  const child = spawn(process.execPath, [path.join(__dirname, "pty-daemon.cjs"), pipe, logFile], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: Object.assign({}, env || process.env, { ELECTRON_RUN_AS_NODE: "1" }),
  });
  child.unref();
}

async function reach(pipe, logFile, env) {
  try {
    return await connectOnce(pipe);
  } catch {
    startDaemon(pipe, logFile, env);
  }
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      return await connectOnce(pipe);
    } catch {
      /* still starting */
    }
  }
  throw new Error("The JAgents terminal service did not start. See " + logFile + ".");
}

async function connectPtyHost({ emit, dataRoot, env, onLost }) {
  const pipe = pipePath(dataRoot);
  const logFile = path.join(dataRoot, "pty-daemon.log");
  fs.mkdirSync(dataRoot, { recursive: true });
  const procs = new Map(); // id -> proxy for the daemon's process
  let sock = null;
  let hello = null;
  let leaving = false;

  function send(msg) {
    if (sock && !sock.destroyed) sock.write(JSON.stringify(msg) + "\n");
  }

  function proxy(id, pid) {
    const p = {
      pid,
      dataFns: [],
      exitFns: [],
      write: (data) => send({ op: "write", id, data: String(data) }),
      resize: (cols, rows) => send({ op: "resize", id, cols, rows }),
      kill: () => send({ op: "kill", id }),
      // The daemon's kill also drops an exited terminal's entry.
      forget: () => send({ op: "kill", id }),
      onData: (fn) => p.dataFns.push(fn),
      onExit: (fn) => p.exitFns.push(fn),
    };
    procs.set(id, p);
    return p;
  }

  function exitProc(id, exitCode) {
    const p = procs.get(id);
    if (!p) return;
    procs.delete(id);
    for (const fn of p.exitFns) fn({ exitCode });
  }

  const host = createPtyHost({
    emit,
    spawn: (opts) => {
      const p = proxy(opts.id, 0);
      send({ op: "create", id: opts.id, command: opts.command, args: opts.args, cwd: opts.cwd, env: opts.env, cols: opts.cols, rows: opts.rows });
      return p;
    },
  });

  function onMessage(msg) {
    const p = procs.get(msg.id);
    if (msg.op === "hello") return hello && hello(msg);
    if (msg.op === "data") return p && p.dataFns.forEach((fn) => fn(msg.data));
    if (msg.op === "exit") return exitProc(msg.id, msg.exitCode);
    if (msg.op === "created") {
      if (p) p.pid = msg.pid;
      return;
    }
    if (msg.op === "failed" && p) {
      p.dataFns.forEach((fn) => fn("\r\n\x1b[31mCould not start: " + msg.error + "\x1b[0m\r\n"));
      exitProc(msg.id, -1);
    }
  }

  sock = await reach(pipe, logFile, env);
  const greeting = new Promise((resolve) => (hello = resolve));
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) onMessage(JSON.parse(line));
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    // The daemon went away: its terminals are gone with it.
    sock = null;
    for (const id of Array.from(procs.keys())) exitProc(id, null);
    if (!leaving && onLost) onLost();
  });

  const first = await Promise.race([greeting, new Promise((_, reject) => setTimeout(() => reject(new Error("The JAgents terminal service did not answer.")), 5000))]);
  if (first.protocol !== PROTOCOL) console.error("pty daemon speaks protocol " + first.protocol + ", this build " + PROTOCOL);
  await Promise.all(first.terms.map((snap) => host.adopt(snap, proxy(snap.id, snap.pid))));

  // Waits until the message is on its way, so it survives the app exiting.
  // Then the mirrors go: an app reloaded in the same process keeps nothing.
  function last(op) {
    leaving = true;
    return new Promise((resolve) => {
      if (!sock || sock.destroyed) return resolve();
      sock.end(JSON.stringify({ op }) + "\n", resolve);
      setTimeout(resolve, 1500);
    }).then(() => host.disposeAll());
  }

  return Object.assign(host, {
    adopted: first.terms.map((t) => t.id),
    daemonPid: first.pid,
    detach: () => last("detach"),
    shutdown: () => last("quit"),
  });
}

module.exports = { connectPtyHost, pipePath };
