"use strict";

// The terminal host's snapshot and query handling, with a stand-in process.
// The real ConPTY runs are checked in the app itself.

const test = require("node:test");
const assert = require("node:assert");
const { createPtyHost } = require("../electron/pty-host.cjs");

function fakeProc() {
  const p = { pid: 1, written: [], dataFns: [], exitFns: [] };
  p.write = (d) => p.written.push(d);
  p.resize = () => {};
  p.kill = () => {};
  p.onData = (fn) => p.dataFns.push(fn);
  p.onExit = (fn) => p.exitFns.push(fn);
  p.emit = (d) => p.dataFns.forEach((fn) => fn(d));
  return p;
}

const tick = () => new Promise((r) => setTimeout(r, 30));

test("the snapshot keeps the mouse format and hidden cursor", async () => {
  const proc = fakeProc();
  const host = createPtyHost({ emit: () => {}, spawn: () => proc });
  host.create({ id: "t1", cols: 80, rows: 24 });
  proc.emit("\x1b[?1003h\x1b[?1006h\x1b[?25l\x1b[5 qhello");
  await tick();
  const snap = host.snapshot("t1");
  assert.match(snap.data, /hello/);
  assert.ok(snap.data.includes("\x1b[?1006h"), "SGR mouse mode");
  assert.ok(snap.data.includes("\x1b[?25l"), "hidden cursor");
  assert.ok(snap.data.includes("\x1b[5 q"), "cursor style");
  host.killAll();
});

test("output parsed before a snapshot is sent before it, not after", async () => {
  const proc = fakeProc();
  const sent = [];
  const host = createPtyHost({ emit: (ch, p) => sent.push(p.data), spawn: () => proc });
  host.create({ id: "t2", cols: 80, rows: 24 });
  proc.emit("first");
  await tick();
  host.snapshot("t2");
  assert.deepStrictEqual(sent.join(""), "first");
  host.killAll();
});

test("only the host that owns the process answers the terminal query", async () => {
  // The app-side host (spawn given) leaves it to the daemon.
  const proc = fakeProc();
  const host = createPtyHost({ emit: () => {}, spawn: () => proc });
  host.create({ id: "t3", cols: 80, rows: 24 });
  proc.emit("\x1b[c");
  await tick();
  assert.deepStrictEqual(proc.written, []);
  host.killAll();
});
