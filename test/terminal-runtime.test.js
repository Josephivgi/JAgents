"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const { createRuntime, mcpConfig, SERVER } = require("../cli/terminal-runtime.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-terminal-test-"));
  const calls = [];
  const ui = {
    flash: (text) => calls.push(["flash", text]),
    schedule() {},
    applySettings: (settings) => calls.push(["settings", settings]),
    control: (action, args) => ({ action, args }),
  };
  const runtime = createRuntime({ ui: () => ui }, { dataRoot: path.join(root, "data"), home: path.join(root, "hub") });
  t.after(() => { runtime.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  return { runtime, root, calls };
}

function request(runtime, route, body, auth = true) {
  const hub = JSON.parse(fs.readFileSync(runtime.hubFile, "utf8"));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1", port: hub.port, path: route,
      method: body === undefined ? "GET" : "POST",
      headers: auth ? { Authorization: "Bearer " + hub.token } : {},
    }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (s) => { text += s; });
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("terminal tools use an authenticated, separate loopback hub", async (t) => {
  const { runtime } = fixture(t);
  await runtime.start();
  assert.equal((await request(runtime, "/servers/" + SERVER + "/tools", undefined, false)).status, 401);
  const listed = await request(runtime, "/servers/" + SERVER + "/tools");
  assert.equal(listed.status, 200);
  for (const name of ["write_plugin", "open_terminal", "read_terminal", "terminal_settings", "reload_terminal"]) {
    assert.ok(listed.body.tools.some((tool) => tool.name === name), name);
  }
  const result = await request(runtime, "/servers/" + SERVER + "/call", { name: "open_terminal", args: { provider: "shell" } });
  assert.deepEqual(result.body.result, { action: "open", args: { provider: "shell" } });
  assert.equal((await request(runtime, "/servers/" + SERVER + "/call", { name: "not_a_tool" })).status, 400);
  assert.equal((await request(runtime, "/nope")).status, 404);
});

test("plugin lifecycle reloads commands, tools, events and SQLite storage", async (t) => {
  const { runtime } = fixture(t);
  await runtime.start();
  const source = (value) => `exports.activate = (ctx) => {
    ctx.storage.set("loads", ctx.storage.get("loads", 0) + 1);
    ctx.terminal.commands.register({ id:"hello", label:"Hello ${value}", handler:() => "${value}" });
    const srv = ctx.mcp.server("clock", {description:"test"});
    srv.tool({name:"now", handler:() => "${value}"});
    srv.tool({name:"counts", handler:() => ({loads: ctx.storage.get("loads"), opened: ctx.storage.get("opened", 0)})});
    ctx.terminal.on("terminal-opened", () => ctx.storage.set("opened", ctx.storage.get("opened", 0) + 1));
  };`;
  const first = await runtime.call("write_plugin", { id: "test", files: { "main.cjs": source("one") } }, { paneId: "7" });
  assert.equal(first.errors.main, "");
  assert.equal(first.author, "terminal-7");
  assert.equal(await runtime.call("run_command", { id: "test.hello" }), "one");
  assert.equal((await request(runtime, "/servers/clock/call", { name: "now" })).body.result, "one");
  runtime.emit("terminal-opened", { id: 1 });
  const second = await runtime.call("write_plugin", { id: "test", files: { "main.cjs": source("two") } });
  assert.equal(second.undoable, 1);
  assert.equal(await runtime.call("run_command", { id: "test.hello" }), "two");
  runtime.emit("terminal-opened", { id: 2 });
  assert.deepEqual(await runtime.plugins.callAppServer("clock", "counts", {}), { loads: 2, opened: 2 });
  await runtime.call("undo_plugin", { id: "test" });
  assert.equal(await runtime.call("run_command", { id: "test.hello" }), "one");
  await runtime.call("set_plugin_enabled", { id: "test", enabled: false });
  assert.equal(runtime.commands().length, 0);
  assert.equal((await request(runtime, "/servers/clock/tools")).status, 400);
  await runtime.call("set_plugin_enabled", { id: "test", enabled: true });
  const removed = await runtime.call("delete_plugin", { id: "test" });
  assert.equal(runtime.commands().length, 0);
  assert.ok(fs.existsSync(path.join(removed.movedTo, "main.cjs")));
});

test("failed plugin activation cleans up partial commands and servers", async (t) => {
  const { runtime } = fixture(t);
  await runtime.start();
  const result = await runtime.call("write_plugin", {
    id: "broken", files: { "main.cjs": `exports.activate = (ctx) => {
      ctx.terminal.commands.register({id:"bad", handler(){}});
      ctx.mcp.server("partial").tool({name:"bad", handler(){}});
      throw new Error("activation failed");
    };` },
  });
  assert.match(result.errors.main, /activation failed/);
  assert.equal(runtime.commands().length, 0);
  assert.equal(runtime.plugins.agentMcp().inApp.length, 0);
});

test("settings and safe mode persist and reject terminal escape injection", async (t) => {
  const { runtime, root } = fixture(t);
  await runtime.start();
  await runtime.call("terminal_settings", { sidebar: false, theme: { accent: "1;2;3" } });
  await assert.rejects(runtime.call("terminal_settings", { theme: { accent: "1;2;300" } }), /Invalid RGB/);
  await assert.rejects(runtime.call("terminal_settings", { theme: { accent: "\x1b[0m" } }), /Invalid RGB/);
  await assert.rejects(runtime.call("set_safe_mode", { enabled: "false" }), /boolean/);
  await runtime.call("set_safe_mode", { enabled: true });
  runtime.stop();
  const next = createRuntime({ ui: () => null }, { dataRoot: path.join(root, "data"), home: path.join(root, "hub") });
  try {
    assert.deepEqual(next.settings(), { sidebar: false, theme: { accent: "1;2;3" } });
    assert.equal(next.plugins.safeMode(), true);
  } finally { next.stop(); }
});

test("tool restrictions apply to discovery, calls and per-launch agent configuration", async (t) => {
  const { runtime } = fixture(t);
  await runtime.start();
  await runtime.call("write_plugin", { id: "restricted", files: {
    "plugin.json": JSON.stringify({ disableTools: ["jagents-terminal.write_terminal", "clock.blocked"], mcpServers: { external: { command: "node", args: ["server.cjs"] } } }),
    "main.cjs": 'exports.activate = ctx => { ctx.mcp.server("clock").tool({name:"blocked", handler:() => "bad"}); };',
  } });
  assert.equal(runtime.tools().some((tool) => tool.name === "write_terminal"), false);
  await assert.rejects(runtime.call("write_terminal", { id: 1, text: "bad" }), /disabled/);
  assert.deepEqual(runtime.plugins.appServerTools("clock").tools, []);
  await assert.rejects(runtime.plugins.callAppServer("clock", "blocked", {}), /turned off/);
  const base = { command: "agent", args: ["entry.js"], env: { KEEP: "yes" } };
  const claude = runtime.paneSpec("claude", base, 9);
  const config = JSON.parse(claude.args[claude.args.indexOf("--mcp-config") + 1]);
  assert.equal(config.mcpServers[SERVER].env.JAGENTS_TERMINAL_HUB_FILE, runtime.hubFile);
  assert.equal(config.mcpServers.clock.env.JAGENTS_SERVER, "clock");
  assert.equal(config.mcpServers.external.env.JAGENTS_PANE_ID, "9");
  assert.equal(claude.env.KEEP, "yes");
  assert.ok(claude.args.includes("mcp__jagents-terminal__write_terminal,mcp__clock__blocked"));
  const codex = runtime.paneSpec("codex", base, 10);
  assert.ok(codex.args.some((s) => s.includes('.disabled_tools=["write_terminal"]')));
  assert.ok(codex.args.some((s) => s.includes('mcp_servers."clock".command=')));
  assert.deepEqual(base.args, ["entry.js"]);
  assert.equal(runtime.paneSpec("shell", base, 1).env.JAGENTS_TERMINAL_HUB_FILE, runtime.hubFile);
});

test("reserved terminal MCP name cannot be replaced", async (t) => {
  const { runtime } = fixture(t);
  await runtime.start();
  const result = await runtime.call("write_plugin", { id: "conflict", files: {
    "main.cjs": 'exports.activate = ctx => ctx.mcp.server("jagents-terminal");',
  } });
  assert.match(result.errors.main, /reserved/);
});

test("invalid edits leave existing files and history unchanged", async (t) => {
  const { runtime } = fixture(t);
  await runtime.start();
  await runtime.call("write_plugin", { id: "valid", files: { "main.cjs": 'exports.activate = () => {};' } });
  for (const files of [
    { "main.cjs": "changed", "../outside.cjs": "bad" },
    { "main.cjs": "changed", "plugin.json": "null" },
    { "main.cjs": "changed", "large.txt": "x".repeat(512 * 1024 + 1) },
  ]) await assert.rejects(runtime.call("write_plugin", { id: "valid", files }));
  assert.equal(runtime.plugins.read("valid").content["main.cjs"], 'exports.activate = () => {};');
  assert.equal(runtime.plugins.info("valid").undoable, 0);
});

test("window endpoints stay separate and stopping one preserves another's pointer", async (t) => {
  const { runtime: one, root } = fixture(t);
  const two = createRuntime({ ui: () => null }, { dataRoot: path.join(root, "data"), home: path.join(root, "hub") });
  try {
    await one.start();
    await two.start();
    assert.notEqual(one.hubFile, two.hubFile);
    const defaultHub = path.join(root, "hub", "hub.json");
    const before = fs.readFileSync(defaultHub, "utf8");
    one.stop();
    assert.equal(fs.readFileSync(defaultHub, "utf8"), before);
    assert.equal((await request(two, "/servers/" + SERVER + "/tools")).status, 200);
  } finally { two.stop(); }
});

test("stdio bridge initializes, discovers tools and completes MCP calls", { timeout: 15000 }, async (t) => {
  const { runtime } = fixture(t);
  await runtime.start();
  const child = spawn(process.execPath, [path.join(__dirname, "..", "cli", "jagents.cjs"), "mcp"], {
    env: { ...process.env, JAGENTS_TERMINAL_HUB_FILE: runtime.hubFile }, stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let pending = "";
  const waiters = new Map();
  child.stdout.setEncoding("utf8").on("data", (text) => {
    pending += text;
    let nl;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const msg = JSON.parse(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
      waiters.get(msg.id)?.(msg);
    }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    waiters.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const initialized = await rpc("initialize", { protocolVersion: "2025-06-18" });
  assert.equal(initialized.result.serverInfo.name, SERVER);
  assert.ok((await rpc("tools/list")).result.tools.some((tool) => tool.name === "write_plugin"));
  const called = await rpc("tools/call", { name: "list_terminals", arguments: {} });
  assert.equal(called.result.isError, false);
  assert.equal(JSON.parse(called.result.content[0].text).action, "list");
  const failed = await rpc("tools/call", { name: "unknown", arguments: {} });
  assert.equal(failed.result.isError, true);
});

test("noninteractive plugin and MCP config commands do not require a TTY", (t) => {
  const { root } = fixture(t);
  const cli = path.join(__dirname, "..", "cli", "jagents.cjs");
  const env = { ...process.env, JAGENTS_TERMINAL_DATA: path.join(root, "cli-data") };
  for (const args of [["plugins"], ["plugins", "docs"], ["mcp-config"], ["terminal", "--help"]]) {
    const out = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(out.status, 0, out.stderr);
    assert.ok(out.stdout.length);
  }
  assert.ok(mcpConfig().mcpServers[SERVER].args[0].endsWith("jagents-terminal-mcp.cjs"));
});
