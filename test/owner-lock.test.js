"use strict";

// One JAgents per data folder (electron/owner-lock.cjs): the real named pipe,
// a second process that held it and died, an owner that does not answer, and
// the checks for desktop builds without the lock.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { acquire, lockPath, otherOwner, dataRootArg, runsScript } = require("../electron/owner-lock.cjs");

const LOCK = path.join(__dirname, "..", "electron", "owner-lock.cjs");
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "jagents-owner-test-"));

test("a second JAgents on the same data folder sees the first as owner", async () => {
  const dataRoot = scratch();
  const first = await acquire({ dataRoot, host: "jworkspace" });
  try {
    assert.strictEqual(first.held, true);
    const second = await acquire({ dataRoot, host: "desktop" });
    assert.strictEqual(second.held, false);
    assert.deepStrictEqual(second.owner, { host: "jworkspace", pid: process.pid });
    // Another data folder is free.
    const other = await acquire({ dataRoot: scratch(), host: "desktop" });
    assert.strictEqual(other.held, true);
    other.release();
  } finally {
    first.release();
  }
});

test("the pipe name follows the folder, not its spelling", () => {
  const dataRoot = scratch();
  assert.strictEqual(lockPath(dataRoot), lockPath(dataRoot.toUpperCase() + path.sep));
  assert.notStrictEqual(lockPath(dataRoot), lockPath(dataRoot + "-other"));
  if (process.platform === "win32") assert.match(lockPath(dataRoot), /^\\\\\.\\pipe\\jagents-owner-[0-9a-f]{12}$/);
});

test("show reaches the owner with the second launch's arguments", async () => {
  const dataRoot = scratch();
  const shown = [];
  const first = await acquire({ dataRoot, host: "jworkspace", onShow: (argv) => shown.push(argv) });
  try {
    const second = await acquire({ dataRoot, host: "desktop" });
    const reply = await second.ask("show", { argv: ["JAgents.exe", "--project=C:\\work"] });
    assert.deepStrictEqual(reply, { ok: true });
    assert.deepStrictEqual(shown, [["JAgents.exe", "--project=C:\\work"]]);
    const unknown = await second.ask("handover");
    assert.strictEqual(unknown.ok, false);
  } finally {
    first.release();
  }
});

test("release frees the folder for the next JAgents", async () => {
  const dataRoot = scratch();
  const first = await acquire({ dataRoot, host: "desktop" });
  first.release();
  first.release();
  const next = await acquire({ dataRoot, host: "jworkspace" });
  assert.strictEqual(next.held, true);
  next.release();
});

test("a lock left by a process that died is free again", async () => {
  const dataRoot = scratch();
  const child = spawn(process.execPath, ["-e", "require(" + JSON.stringify(LOCK) + ").acquire({ dataRoot: " + JSON.stringify(dataRoot) + ", host: 'desktop' }).then((l) => { console.log(l.held ? 'held' : 'not held'); setInterval(() => {}, 1000); })"], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    const first = await new Promise((resolve) => child.stdout.once("data", (d) => resolve(String(d).trim())));
    assert.strictEqual(first, "held");
    const meanwhile = await acquire({ dataRoot, host: "jworkspace" });
    assert.strictEqual(meanwhile.held, false);
    assert.strictEqual(meanwhile.owner.pid, child.pid);
  } finally {
    // A crash, not a clean release: the process is ended from outside.
    child.kill("SIGKILL");
    await exited;
  }
  const after = await acquire({ dataRoot, host: "jworkspace" });
  assert.strictEqual(after.held, true);
  after.release();
});

test("an owner that does not answer still keeps the folder", async () => {
  const dataRoot = scratch();
  const pipe = lockPath(dataRoot);
  const mute = net.createServer(() => {});
  await new Promise((resolve) => mute.listen(pipe, resolve));
  try {
    const started = Date.now();
    const got = await acquire({ dataRoot, host: "jworkspace" });
    assert.strictEqual(got.held, false);
    assert.strictEqual(got.owner, null);
    assert.ok(Date.now() - started < 5000);
  } finally {
    mute.close();
  }
});

test("--data-root= is read from a JAgents.exe command line", () => {
  assert.strictEqual(dataRootArg('"C:\\Programs\\JAgents\\JAgents.exe" --data-root=C:\\dev-data'), "C:\\dev-data");
  assert.strictEqual(dataRootArg('"C:\\JAgents.exe" "--data-root=C:\\my data"'), "C:\\my data");
  assert.strictEqual(dataRootArg('"C:\\JAgents.exe" --data-root="C:\\my data" --x'), "C:\\my data");
  assert.strictEqual(dataRootArg('"C:\\JAgents.exe" --project=C:\\work'), "");
});

test("desktop builds without the lock are found by their process", async () => {
  const dataRoot = scratch();
  const homeDir = scratch();
  const exe = '"C:\\Users\\x\\AppData\\Local\\Programs\\JAgents\\JAgents.exe"';
  const check = (rows, isolated) => otherOwner({ dataRoot, homeDir, isolated, list: async () => rows });
  // The app's own page, GPU and pty daemon processes are not the app.
  assert.strictEqual(await check([{ pid: 11, name: "JAgents.exe", cmd: exe + " --type=renderer" }, { pid: 12, name: "JAgents.exe", cmd: exe + " C:\\app\\electron\\pty-daemon.cjs \\\\.\\pipe\\x log" }], false), null);
  // Nor is JAgents.exe running the jagents MCP servers for an agent (node not on PATH).
  assert.strictEqual(await check([{ pid: 16, name: "JAgents.exe", cmd: exe + " C:\\Users\\x\\.jagents\\jagents-mcp.cjs" }, { pid: 17, name: "JAgents.exe", cmd: exe + ' "C:\\Users\\x y\\.jagents\\jagents-plugin-mcp.cjs"' }], false), null);
  // The main process on the default folder, on this folder, or on another one.
  assert.deepStrictEqual(await check([{ pid: 13, name: "JAgents.exe", cmd: exe }], false), { pid: 13, why: "JAgents.exe is running" });
  assert.strictEqual(await check([{ pid: 13, name: "JAgents.exe", cmd: exe }], true), null);
  assert.strictEqual((await check([{ pid: 14, name: "JAgents.exe", cmd: exe + ' "--data-root=' + dataRoot.toUpperCase() + '"' }], true)).pid, 14);
  assert.strictEqual(await check([{ pid: 15, name: "JAgents.exe", cmd: exe + " --data-root=C:\\elsewhere" }], false), null);
  assert.strictEqual(runsScript(exe + " C:\\app\\mcp\\jagents-mcp.cjs"), true);
  assert.strictEqual(runsScript(exe + " --project=C:\\work"), false);
  assert.strictEqual(runsScript(exe), false);
});

test("the hub file counts only when its hub answers with its token", async () => {
  const dataRoot = scratch();
  const homeDir = scratch();
  const token = "secret-token";
  const hubServer = http.createServer((req, res) => {
    res.writeHead(req.headers.authorization === "Bearer " + token ? 200 : 401, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => hubServer.listen(0, "127.0.0.1", resolve));
  const port = hubServer.address().port;
  const hubFile = (o) => fs.writeFileSync(path.join(homeDir, "hub.json"), JSON.stringify(o));
  const owner = (list) => otherOwner({ dataRoot, homeDir, isolated: true, list: list || (async () => []) });
  // A pid that is alive but is not JAgents' (here the test runner's parent).
  const live = process.ppid;
  try {
    hubFile({ port, token, pid: live });
    assert.deepStrictEqual(await owner(), { pid: live, why: "the hub file names a running JAgents" });
    // Windows could not list processes: the hub's answer still decides.
    assert.deepStrictEqual(await owner(async () => null), { pid: live, why: "the hub file names a running JAgents" });
    // Another program's server on that port does not know the token.
    hubFile({ port, token: "other", pid: live });
    assert.strictEqual(await owner(), null);
    // This process's own hub, and a hub whose JAgents has gone, do not count.
    hubFile({ port, token, pid: process.pid });
    assert.strictEqual(await owner(), null);
    hubFile({ port, token, pid: 2147483646 });
    assert.strictEqual(await owner(), null);
  } finally {
    await new Promise((resolve) => hubServer.close(resolve));
  }
  // A stale file left by a crash: its pid now belongs to another live
  // program, and nothing answers on its port.
  hubFile({ port, token, pid: live });
  assert.strictEqual(await owner(async () => null), null);
  assert.strictEqual(await owner(async () => [{ pid: live, name: "electron.exe", cmd: "electron.exe --type=renderer" }]), null);
});

test("the process query finds a process by pid", { skip: process.platform !== "win32" }, async () => {
  const { processes } = require("../electron/owner-lock.cjs");
  const rows = await processes(process.pid);
  assert.ok(Array.isArray(rows), "Windows answered");
  const me = rows.find((r) => r.pid === process.pid);
  assert.ok(me, "this process is listed");
  assert.match(me.name, /^node(\.exe)?$/i);
  assert.ok(me.cmd.length > 0);
});

test("the CLI's Desktop button asks the owner first and launches nothing when one answers", async () => {
  const { askOwner } = require("../cli/desktop.cjs");
  const ask = (dataRoot) => new Promise((resolve) => askOwner(dataRoot, "C:\work", (answered, message) => resolve({ answered, message })));
  const dataRoot = scratch();
  // Nobody holds the folder: the desktop app is launched as before.
  assert.deepStrictEqual(await ask(dataRoot), { answered: false, message: undefined });
  const shown = [];
  let refuse = "";
  const owner = await acquire({
    dataRoot,
    host: "jworkspace",
    onShow: (argv) => {
      if (refuse) throw new Error(refuse);
      shown.push(argv);
    },
  });
  try {
    assert.deepStrictEqual(await ask(dataRoot), { answered: true, message: "" });
    assert.deepStrictEqual(shown, [["--project=C:\work"]]);
    // An owner that cannot show JAgents says why; nothing is launched.
    refuse = "Quit JWorkspace, then open JAgents again.";
    assert.deepStrictEqual(await ask(dataRoot), { answered: true, message: refuse });
  } finally {
    owner.release();
  }
});
