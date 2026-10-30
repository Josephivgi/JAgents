const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const link = require("../electron/jworkspace-link.cjs");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jagents-jw-"));
}

test("no JWorkspace folder: not found, no MCP entry", () => {
  const home = scratch();
  try {
    const d = link.detect({ home: path.join(home, "JWorkspace") });
    assert.strictEqual(d.found, false);
    assert.strictEqual(d.running, false);
    assert.strictEqual(link.mcpEntry({ home: path.join(home, "JWorkspace") }), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("JWORKSPACE_HOME, then APPDATA\\JWorkspace", () => {
  assert.strictEqual(link.defaultHome({ JWORKSPACE_HOME: "C:\\x\\jw" }), path.resolve("C:\\x\\jw"));
  assert.strictEqual(link.defaultHome({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }), path.join("C:\\Users\\a\\AppData\\Roaming", "JWorkspace"));
});

test("JWorkspace there: found, running from control.json, entry runs the server", () => {
  const home = scratch();
  try {
    fs.mkdirSync(path.join(home, "mcp", "mcp"), { recursive: true });
    // Stands in for the server: prints the home it was given.
    fs.writeFileSync(path.join(home, "mcp", "mcp", "jworkspace-mcp.cjs"), "process.stdout.write(process.env.JWORKSPACE_HOME)");
    fs.writeFileSync(path.join(home, "mcp", "app.json"), JSON.stringify({ version: "0.4.0", electron: path.join(home, "missing.exe") }));

    let d = link.detect({ home });
    assert.strictEqual(d.found, true);
    assert.strictEqual(d.running, false);
    assert.strictEqual(d.version, "0.4.0");
    assert.strictEqual(d.electron, "");

    fs.writeFileSync(path.join(home, "control.json"), JSON.stringify({ pid: process.pid }));
    d = link.detect({ home });
    assert.strictEqual(d.running, true);

    const e = link.mcpEntry({ home });
    assert.strictEqual(e.name, "jworkspace");
    assert.strictEqual(e.command, process.execPath);
    const env = Object.fromEntries(e.env.map((x) => [x.name, x.value]));
    assert.strictEqual(env.JWORKSPACE_HOME, home);
    assert.strictEqual(env.ELECTRON_RUN_AS_NODE, "1");
    const out = execFileSync(e.command, e.args, { env: Object.assign({}, process.env, env), encoding: "utf8", windowsHide: true });
    assert.strictEqual(out, home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
