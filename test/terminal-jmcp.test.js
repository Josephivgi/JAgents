"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const CLI = path.join(__dirname, "..", "cli", "jagents.cjs");

// A JMCP data folder laid out the way JMCP writes it.
function jmcpHome(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-jmcp-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [id, version] of [["subagents", "0.3.2"], ["memory", "0.2.0"]]) {
    fs.mkdirSync(path.join(root, "servers", id), { recursive: true });
    fs.writeFileSync(path.join(root, "servers", id, "server.cjs"), "");
    fs.writeFileSync(path.join(root, "servers", id, "package.json"), JSON.stringify({ version }));
  }
  fs.mkdirSync(path.join(root, "servers", "notes"));
  const db = new DatabaseSync(path.join(root, "subagents.db"));
  db.exec("CREATE TABLE subagents (session TEXT NOT NULL, handle TEXT NOT NULL, parent TEXT, provider TEXT, provider_name TEXT, task TEXT, cwd TEXT, status TEXT, error TEXT, model TEXT, effort TEXT, workflow TEXT, created_at INTEGER, updated_at INTEGER, transcript TEXT, PRIMARY KEY (session, handle))");
  const add = db.prepare("INSERT INTO subagents (session, handle, provider, provider_name, task, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  add.run("s1", "claude-7", "claude", "Claude Code", "Review the parser\nfor bugs", "running", Date.now() - 5000);
  add.run("s1", "droid-2", "droid", "Factory Droid", "Old task", "stopped", Date.now() - 7200000);
  db.close();
  return root;
}

function fresh(env) {
  delete require.cache[require.resolve("../cli/jmcp.cjs")];
  Object.assign(process.env, env);
  return require("../cli/jmcp.cjs");
}

test("JMCP status reads servers and subagents, newest first", (t) => {
  const home = jmcpHome(t);
  const jmcp = fresh({ JMCP_HOME: home, JMCP_APP_DIR: path.join(home, "no-app") });
  const s = jmcp.status("");
  assert.equal(s.installed, true);
  assert.equal(s.app, false);
  assert.deepEqual(s.servers.map((x) => x.name + "@" + x.version), ["jmcp-memory@0.2.0", "jmcp-subagents@0.3.2"]);
  assert.equal(s.working, 1);
  assert.deepEqual(s.subagents.map((x) => x.handle), ["claude-7", "droid-2"]);
  assert.equal(s.subagents[0].task, "Review the parser for bugs");
  assert.equal(s.connected, false);
  assert.equal(s.canConnect, false);
});

test("JMCP missing reports not installed and never throws", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-jmcp-none-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jmcp = fresh({ JMCP_HOME: path.join(root, "home"), JMCP_APP_DIR: path.join(root, "app") });
  const s = jmcp.status(path.join(root, "plugins"));
  assert.equal(s.installed, false);
  assert.deepEqual(s.subagents, []);
  assert.match(jmcp.report(""), /JMCP is not installed[\s\S]*jagents jmcp install[\s\S]*works without JMCP/);
});

test("the jmcp plugin JMCP writes counts as connected, other plugins do not", (t) => {
  const home = jmcpHome(t);
  const plugins = path.join(home, "plugins");
  const jmcp = fresh({ JMCP_HOME: home, JMCP_APP_DIR: path.join(home, "no-app") });
  fs.mkdirSync(path.join(plugins, "jmcp"), { recursive: true });
  fs.writeFileSync(path.join(plugins, "jmcp", "connection.json"), JSON.stringify({ by: "someone" }));
  assert.equal(jmcp.status(plugins).connected, false);
  fs.writeFileSync(path.join(plugins, "jmcp", "connection.json"), JSON.stringify({ by: "JMCP", app: "jagents-terminal" }));
  assert.equal(jmcp.status(plugins).connected, true);
});

test("connect is offered only by a JMCP CLI that has it", (t) => {
  const home = jmcpHome(t);
  const app = path.join(home, "app");
  const cli = path.join(app, "resources", "app", "cli");
  fs.mkdirSync(cli, { recursive: true });
  fs.writeFileSync(path.join(cli, "jmcp.cjs"), 'if (cmd === "list") {}');
  const jmcp = fresh({ JMCP_HOME: home, JMCP_APP_DIR: app });
  assert.equal(jmcp.status("").canConnect, false);
  fs.writeFileSync(path.join(cli, "jmcp.cjs"), 'if (cmd === "connect" || cmd === "disconnect") {}');
  assert.equal(jmcp.status("").canConnect, true);
});

test("jagents jmcp prints status without a TTY", (t) => {
  const home = jmcpHome(t);
  const r = spawnSync(process.execPath, [CLI, "jmcp"], { encoding: "utf8", windowsHide: true, env: { ...process.env, JMCP_HOME: home, JMCP_APP_DIR: path.join(home, "no-app"), JAGENTS_TERMINAL_DATA: path.join(home, "terminal") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Servers \(2\)/);
  assert.match(r.stdout, /Subagents \(1 working, 2 recent\)/);
  assert.match(r.stdout, /claude-7 +running +Claude Code/);
  const bad = spawnSync(process.execPath, [CLI, "jmcp", "nope"], { encoding: "utf8", windowsHide: true });
  assert.equal(bad.status, 1);
});

test("real TUI shows JMCP subagents, opens the JMCP tab", { timeout: 40000 }, (t) => {
  const home = jmcpHome(t);
  const r = spawnSync(process.execPath, [path.join(__dirname, "fixtures", "terminal-jmcp-check.cjs"), "connected", home], { encoding: "utf8", timeout: 35000, windowsHide: true });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /JMCP connected checks passed/);
});

test("real TUI asks to install JMCP when it is missing", { timeout: 40000 }, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, "fixtures", "terminal-jmcp-check.cjs"), "missing"], { encoding: "utf8", timeout: 35000, windowsHide: true });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /JMCP missing checks passed/);
});
