"use strict";

// Runs the real jagents TUI in a PTY against a JMCP data folder (argv[2]),
// or with JMCP missing (argv[2] = "missing"), and checks what it shows.

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

const mode = process.argv[2];
const jmcpHome = process.argv[3];

async function verify(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-jmcp-test-"));
  const home = path.join(root, "hub");
  const data = path.join(root, "data");
  const screen = new Terminal({ cols: 120, rows: 34, scrollback: 200, allowProposedApi: true });
  const env = { ...process.env, JAGENTS_TERMINAL_HOME: home, JAGENTS_TERMINAL_DATA: data, JAGENTS_SAFE_MODE: "0", JMCP_APP_DIR: path.join(root, "no-jmcp-app") };
  env.JMCP_HOME = mode === "missing" ? path.join(root, "no-jmcp") : jmcpHome;
  const child = pty.spawn(process.execPath, [path.join(appRoot, "cli", "jagents.cjs"), "shell"], { name: "xterm-256color", cols: 120, rows: 34, cwd: root, useConptyDll: true, env });
  let stopped = false;
  t.after(async () => {
    const exited = new Promise((resolve) => { child.onExit(resolve); if (stopped) resolve(); });
    try { child.kill(); } catch { /* gone */ }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
    screen.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const waiting = new Set();
  const text = () => {
    const buffer = screen.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i)?.translateToString(true) || "").join("\n");
  };
  child.onData((d) => screen.write(d, () => {
    for (const w of waiting) if (w.predicate()) { waiting.delete(w); w.resolve(); }
  }));
  child.onExit(() => { stopped = true; });
  const until = (predicate, what) => new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const timer = setTimeout(() => reject(new Error("Timed out waiting for " + what + "\n" + text())), 15000);
    waiting.add({ predicate, resolve: () => { clearTimeout(timer); resolve(); } });
  });
  function call(name, args = {}) {
    const hub = JSON.parse(fs.readFileSync(path.join(home, "hub.json"), "utf8"));
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: hub.port, method: "POST", path: "/servers/jagents-terminal/call", headers: { Authorization: "Bearer " + hub.token } }, (res) => {
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

  await until(() => text().includes("New terminal") && fs.existsSync(path.join(home, "hub.json")), "the window");
  assert.match(text(), /JAgents Terminal/);

  if (mode === "missing") {
    await until(() => text().includes("↓  Install JMCP"), "the sidebar install line");
    assert.match(text(), /Install JMCP to give the agents here MCP servers and subagents: Ctrl\+B j/);
    child.write("\x02j");
    await until(() => text().includes("Install JMCP?"), "the install card");
    assert.match(text(), /jagents-terminal MCP works without JMCP/);
    assert.match(text(), /Don't ask again/);
    child.write("\x1b");
    await until(() => !text().includes("Install JMCP?"), "the card to close");
    process.stdout.write("JMCP missing checks passed.\n");
    return;
  }

  await until(() => text().includes("⇄  JMCP  1 working"), "the sidebar JMCP line");
  child.write("\x02j");
  await until(() => text().includes("SUBAGENTS  1 working, 2 recent"), "the JMCP card");
  assert.match(text(), /claude-7 +running +Claude Code/);
  assert.match(text(), /Review the parser/);
  assert.match(text(), /Servers: memory, subagents/);
  child.write("t");
  await until(() => text().includes("Subagents (1 working, 2 recent)"), "the JMCP tab");
  const panes = await call("list_terminals");
  assert.ok(panes.some((p) => p.provider === "jmcp" && p.name === "JMCP"), JSON.stringify(panes));
  process.stdout.write("JMCP connected checks passed.\n");
}

const cleanup = [];
verify({ after: (fn) => cleanup.push(fn) }).then(async () => {
  for (const fn of cleanup.reverse()) await fn();
  process.exit(0);
}, async (error) => {
  for (const fn of cleanup.reverse()) await fn();
  process.stderr.write(String(error.stack || error) + "\n");
  process.exit(1);
});
