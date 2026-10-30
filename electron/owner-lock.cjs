"use strict";

// One JAgents at a time per data folder. The desktop app and JAgents inside
// JWorkspace can open the same data (threads, the terminals in the pty
// daemon, the hub), and two at once break each other's terminals. The owner
// listens on a named pipe for its data folder: a second listener gets
// EADDRINUSE, and Windows frees the pipe when the owner's process ends. A
// JAgents that finds it taken asks the owner who it is, or asks it to show
// itself, and does not start.
//
// Builds from before the lock (0.6.5 and older) do not hold it; otherOwner()
// finds them by their process and by their hub answering.
//
// Messages are one line of JSON each way: {op: "who"} -> {ok, host, pid},
// {op: "show", argv} -> {ok}.

const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");

const ASK_MS = 2000;
const HUB_MS = 1500;

function lockPath(dataRoot) {
  const tag = createHash("sha1").update(path.resolve(dataRoot).toLowerCase()).digest("hex").slice(0, 12);
  return process.platform === "win32" ? "\\\\.\\pipe\\jagents-owner-" + tag : path.join(os.tmpdir(), "jagents-owner-" + tag + ".sock");
}

function ask(pipe, msg, ms) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = "";
    const fail = (error) => {
      clearTimeout(timer);
      sock.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error("The JAgents that has this data folder did not answer."), { code: "ETIMEDOUT" })), ms || ASK_MS);
    sock.setEncoding("utf8");
    sock.on("error", fail);
    sock.on("connect", () => sock.write(JSON.stringify(msg) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function listen(pipe, onConnection) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(onConnection);
    server.once("error", reject);
    server.listen(pipe, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

// acquire({ dataRoot, host, onShow }) resolves to
//   { held: true, pipe, release() }                this process owns the folder
//   { held: false, pipe, owner, ask(op, extra) }   another one does; owner is
//                                                   { host, pid }, or null when it did not answer
// host is "desktop" or "jworkspace"; onShow(argv) runs when another JAgents
// asks this one to come forward.
async function acquire(opts, retried) {
  const { dataRoot, host, onShow } = opts;
  const pipe = opts.pipe || lockPath(dataRoot);
  const conns = new Set();
  const answer = (sock, msg) => {
    const reply = (obj) => !sock.destroyed && sock.end(JSON.stringify(obj) + "\n");
    if (msg.op === "who") return reply({ ok: true, host, pid: process.pid, dataRoot: path.resolve(dataRoot) });
    if (msg.op === "show") {
      try {
        if (onShow) onShow(Array.isArray(msg.argv) ? msg.argv.map(String) : []);
        return reply({ ok: true });
      } catch (error) {
        return reply({ ok: false, error: String(error.message || error) });
      }
    }
    reply({ ok: false, error: "Unknown request " + msg.op });
  };
  let server;
  try {
    server = await listen(pipe, (sock) => {
      conns.add(sock);
      let buf = "";
      sock.setEncoding("utf8");
      sock.on("error", () => {});
      sock.on("close", () => conns.delete(sock));
      sock.on("data", (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        let msg = {};
        try {
          msg = JSON.parse(buf.slice(0, nl)) || {};
        } catch {
          /* answered as unknown */
        }
        buf = "";
        answer(sock, msg);
      });
    });
  } catch (error) {
    if (error.code !== "EADDRINUSE") throw error;
    let who = null;
    try {
      who = await ask(pipe, { op: "who" });
    } catch (e) {
      // Nobody listens: the owner let go a moment ago, or (not on Windows) a
      // crashed owner left its socket file. Try once more.
      if (!retried && (e.code === "ECONNREFUSED" || e.code === "ENOENT")) {
        if (process.platform !== "win32") fs.rmSync(pipe, { force: true });
        return acquire(opts, true);
      }
    }
    return {
      held: false,
      pipe,
      owner: who && who.ok ? { host: String(who.host || ""), pid: Number(who.pid) || 0 } : null,
      ask: (op, extra) => ask(pipe, Object.assign({}, extra, { op })),
    };
  }
  let released = false;
  return {
    held: true,
    pipe,
    release() {
      if (released) return;
      released = true;
      server.close();
      for (const sock of conns) sock.destroy();
    },
  };
}

// ---- builds without the lock ------------------------------------------------

// JAgents.exe processes (and the one with extraPid), from one hidden CIM
// query: [{ pid, name, cmd }], or null when Windows could not be asked.
function processes(extraPid) {
  if (process.platform !== "win32") return Promise.resolve(null);
  const filter = "Name='JAgents.exe'" + (extraPid ? " OR ProcessId=" + Number(extraPid) : "");
  const ps = "Get-CimInstance Win32_Process -Filter \"" + filter + "\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      try {
        const text = String(out).trim();
        const rows = text ? JSON.parse(text) : [];
        resolve((Array.isArray(rows) ? rows : [rows]).map((r) => ({ pid: Number(r.ProcessId) || 0, name: String(r.Name || ""), cmd: String(r.CommandLine || "") })));
      } catch {
        resolve(null);
      }
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// The data folder a JAgents.exe was started on, from --data-root=; "" when
// it has none (then it uses JAGENTS_DATA_ROOT or %APPDATA%\JAgents).
function dataRootArg(cmd) {
  const m = /"--data-root=([^"]*)"/.exec(cmd) || /--data-root=(?:"([^"]*)"|([^\s"]+))/.exec(cmd);
  return m ? m[1] || m[2] || "" : "";
}

// A JAgents.exe whose first argument is a script is JAgents' runtime used as
// node, not the app: the pty daemon, or the jagents MCP server an agent
// starts with JAgents.exe when node is not on PATH.
function runsScript(cmd) {
  const rest = String(cmd).trim().replace(/^"[^"]*"|^\S+/, "").trim();
  const first = /^"([^"]*)"|^(\S+)/.exec(rest);
  return Boolean(first) && /\.[cm]?js$/i.test(first[1] || first[2]);
}

// True when the hub named in hub.json answers with its token. A file left by
// a JAgents that crashed or was killed names a closed port, and its pid may
// belong to another program by now.
function hubAnswers(hub) {
  const port = Number(hub && hub.port);
  if (!(port > 0 && port < 65536) || !hub.token) return Promise.resolve(false);
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/tools", headers: { Authorization: "Bearer " + hub.token }, timeout: HUB_MS }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

// A JAgents without the owner lock that has this data folder open, or null.
//   A JAgents.exe main process (not its page, GPU or pty daemon processes,
//   nor JAgents.exe running an MCP server) started on this folder. One
//   started without --data-root counts unless this run is isolated (a
//   scratch folder no desktop app uses).
//   The hub in the hub file answering, when it is not this process's.
// list() stands in for the process query in tests.
async function otherOwner({ dataRoot, homeDir, isolated, list }) {
  let hub = null;
  try {
    hub = JSON.parse(fs.readFileSync(path.join(homeDir, "hub.json"), "utf8"));
  } catch {
    hub = null;
  }
  const hubPid = hub && Number(hub.pid) !== process.pid && alive(Number(hub.pid)) ? Number(hub.pid) : 0;
  const [rows, hubUp] = await Promise.all([(list || processes)(), hubPid ? hubAnswers(hub) : false]);
  if (rows) {
    for (const p of rows) {
      if (!/^jagents\.exe$/i.test(p.name) || /--type=|pty-daemon/i.test(p.cmd) || runsScript(p.cmd)) continue;
      const root = dataRootArg(p.cmd);
      if (root ? samePath(root, dataRoot) : !isolated) return { pid: p.pid, why: "JAgents.exe is running" };
    }
  }
  if (hubUp) return { pid: hubPid, why: "the hub file names a running JAgents" };
  return null;
}

module.exports = { acquire, ask, lockPath, otherOwner, dataRootArg, runsScript, processes };
