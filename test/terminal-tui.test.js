"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("real TUI panes, plugin menu and MCP survive a UI reload", { timeout: 40000 }, () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, "fixtures", "terminal-tui-check.cjs")], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Terminal integration passed/);
});
