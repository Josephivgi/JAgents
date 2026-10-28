"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createRequire } = require("node:module");
const appRoot = path.join(__dirname, "..", "..");
const cliRequire = createRequire(path.join(appRoot, "cli", "package.json"));
const pty = cliRequire("node-pty");
const { Terminal } = cliRequire("@xterm/headless");

async function verify(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-tui-test-"));
  const home = path.join(root, "hub");
  const screen = new Terminal({ cols: 110, rows: 32, scrollback: 200, allowProposedApi: true });
  const child = pty.spawn(process.execPath, [path.join(appRoot, "cli", "jagents.cjs"), "shell"], {
    name: "xterm-256color", cols: 110, rows: 32, cwd: root,
    useConptyDll: true,
    env: { ...process.env, JAGENTS_TERMINAL_HOME: home, JAGENTS_TERMINAL_DATA: path.join(root, "data"), JAGENTS_SAFE_MODE: "0" },
  });
  let stopped = false;
  t.after(async () => {
    const exited = new Promise((resolve) => { child.onExit(resolve); if (stopped) resolve(); });
    // node-pty's ConPTY worker must be closed even after a clean child exit.
    try { child.kill(); } catch { /* child already gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    screen.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  let raw = "";
  const waiting = new Set();
  const text = () => {
    const buffer = screen.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) || "").join("\n");
  };
  const check = () => {
    for (const waiter of waiting) if (waiter.predicate()) { waiting.delete(waiter); waiter.resolve(); }
  };
  child.onData((data) => {
    raw += data;
    screen.write(data, check);
  });
  child.onExit(() => { stopped = true; });
  const until = (predicate) => new Promise((resolve) => {
    if (predicate()) return resolve();
    waiting.add({ predicate, resolve });
  });
  await until(() => text().includes("New terminal") && fs.existsSync(path.join(home, "hub.json")));
  const initial = text();
  assert.ok(initial.indexOf("◇  Plugins") < initial.indexOf("+  New terminal"));
  assert.ok(initial.includes("◇  Plugins"));

  function call(name, args = {}) {
    const hub = JSON.parse(fs.readFileSync(path.join(home, "hub.json"), "utf8"));
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: "127.0.0.1", port: hub.port, method: "POST", path: "/servers/jagents-terminal/call",
        headers: { Authorization: "Bearer " + hub.token },
      }, (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (s) => { body += s; });
        res.on("end", () => {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 400) reject(new Error(parsed.error));
          else resolve(parsed.result);
        });
      });
      req.on("error", reject);
      req.end(JSON.stringify({ name, args }));
    });
  }

  const original = (await call("list_terminals"))[0];
  assert.ok(original.pid > 0);
  await call("rename_terminal", { id: original.id, name: "MCP shell" });
  await assert.rejects(call("rename_terminal", { id: original.id, name: "\x1b[2J" }), /control characters/);
  await call("write_terminal", { id: original.id, text: "echo JAGENTS_PTY_OK", enter: true });
  await until(() => text().split("\n").some((line) => line.replace(/^.*?│/, "").trim() === "JAGENTS_PTY_OK"));
  assert.match((await call("read_terminal", { id: original.id })).text, /JAGENTS_PTY_OK/);
  const split = await call("open_terminal", { provider: "shell", name: "Split shell", mode: "right" });
  assert.equal((await call("list_terminals")).length, 2);
  await call("focus_terminal", { id: original.id });
  assert.equal((await call("list_terminals")).find((p) => p.id === original.id).focused, true);
  await call("close_terminal", { id: split.id });
  assert.equal((await call("list_terminals")).length, 1);

  const plugin = await call("write_plugin", { id: "tui-test", files: {
    "main.cjs": 'exports.activate = ctx => { ctx.terminal.commands.register({id:"rename", label:"Plugin rename", handler:() => ctx.terminal.rename({id:ctx.terminal.list()[0].id, name:"Plugin shell"})}); };',
  } });
  assert.equal(plugin.errors.main, "");
  child.write("\x02e");
  await until(() => text().includes("Plugin rename"));
  await call("write_plugin", { id: "tui-test", files: {
    "main.cjs": 'exports.activate = ctx => { ctx.terminal.commands.register({id:"rename", label:"Plugin rename updated", handler:() => ctx.terminal.rename({id:ctx.terminal.list()[0].id, name:"Plugin shell"})}); };',
  } });
  await until(() => text().includes("Plugin rename updated"));
  await call("run_command", { id: "tui-test.rename" });
  assert.equal((await call("list_terminals"))[0].name, "Plugin shell");
  child.write("\x1b");
  await call("reload_terminal");
  await until(() => raw.includes("JAgents Terminal reloaded with the new code"));
  const after = (await call("list_terminals"))[0];
  assert.equal(after.id, original.id);
  assert.equal(after.pid, original.pid);
  await call("terminal_settings", { sidebar: false });
  await call("terminal_settings", { sidebar: true, theme: { accent: "151;146;236" } });
}

const cleanup = [];
verify({ after: (fn) => cleanup.push(fn) }).then(async () => {
  for (const fn of cleanup.reverse()) await fn();
  process.stdout.write("Terminal integration passed.\n");
  // ConPTY can retain native worker handles after disconnect on Windows.
  // This fixture owns the PTY; do not let those handles hang the test runner.
  process.exit(0);
}, async (error) => {
  for (const fn of cleanup.reverse()) await fn();
  process.stderr.write(String(error.stack || error) + "\n");
  process.exit(1);
});
