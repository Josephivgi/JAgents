"use strict";

// The pty daemon: a small background process that owns the terminal panes'
// processes, so they keep running while JAgents restarts (after an update, or
// when an agent calls restart_jagents). The app talks to it over a named pipe
// with newline-delimited JSON (pty-client.cjs). One app at a time; a new
// connection takes over and gets every terminal's screen to redraw.
//
// Started by the app as: ELECTRON_RUN_AS_NODE=1 <electron> pty-daemon.cjs <pipe> <log>
// It closes every terminal and exits when the app quits for real, or when no
// app has connected for ORPHAN_MS (the app crashed and was not reopened).

delete process.env.ELECTRON_RUN_AS_NODE;

const fs = require("node:fs");
const net = require("node:net");
const { createPtyHost } = require("./pty-host.cjs");

const PROTOCOL = 1;
const ORPHAN_MS = 10 * 60 * 1000;
const [pipe, logFile] = process.argv.slice(2);

function log(text) {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, new Date().toISOString() + " [" + process.pid + "] " + text + "\n");
  } catch {
    /* logging is best effort */
  }
}

let client = null;
let orphanTimer = null;

function send(msg) {
  if (client && !client.destroyed) client.write(JSON.stringify(msg) + "\n");
}

const host = createPtyHost({ emit: (channel, payload) => send(Object.assign({ op: channel === "pty-data" ? "data" : "exit" }, payload)) });

function shutdown(why) {
  log("closing every terminal: " + why);
  host.killAll();
  if (server) server.close();
  // node-pty's kill finishes on its own thread; give it a moment.
  setTimeout(() => process.exit(0), 300);
}

function orphan() {
  clearTimeout(orphanTimer);
  orphanTimer = setTimeout(() => shutdown("no JAgents window for " + ORPHAN_MS / 60000 + " minutes"), ORPHAN_MS);
}

function handle(sock, msg) {
  switch (msg.op) {
    case "create":
      try {
        const out = host.create(msg);
        send({ op: "created", id: msg.id, pid: out.pid });
      } catch (error) {
        send({ op: "failed", id: msg.id, error: String(error.message || error) });
      }
      return;
    case "write":
      return host.write(msg.id, msg.data);
    case "resize":
      return host.resize(msg.id, msg.cols, msg.rows);
    case "kill":
      return host.kill(msg.id);
    case "detach":
      log("app restarting; " + host.ids().length + " terminals stay open");
      return;
    case "quit":
      return shutdown("JAgents quit");
    default:
      log("unknown op " + msg.op);
  }
}

function attach(sock) {
  // Parsed output not sent yet goes to the old app (or nowhere), so the new
  // one gets it once, inside the snapshot.
  host.flushAll();
  if (client) client.destroy();
  client = sock;
  clearTimeout(orphanTimer);
  send({ op: "hello", protocol: PROTOCOL, pid: process.pid, terms: host.ids().map((id) => host.snapshot(id)) });
  log("app connected; " + host.ids().length + " terminals");
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        handle(sock, JSON.parse(line));
      } catch (error) {
        log("bad message: " + error.message);
      }
    }
  });
  sock.on("error", () => {});
  sock.on("close", () => {
    if (client !== sock) return;
    client = null;
    orphan();
  });
}

const server = net.createServer(attach);
server.on("error", (error) => {
  // Another daemon already serves this data folder.
  log("cannot listen on " + pipe + ": " + error.message);
  process.exit(0);
});
if (process.platform !== "win32") {
  try {
    fs.unlinkSync(pipe);
  } catch {
    /* no stale socket */
  }
}
server.listen(pipe, () => log("listening on " + pipe));
orphan();
