const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { writeDevinMcpConfig } = require("../electron/acp-host.cjs");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
}

const entries = [{ name: "gh", command: "node", args: ["x.js"], env: [{ name: "GITHUB_TOKEN", value: "test-not-a-real-token" }] }];

test("Devin config in a git repo is excluded from git", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-devin-"));
  try {
    git(repo, "init", "-q");
    writeDevinMcpConfig(repo, entries);
    writeDevinMcpConfig(repo, entries);
    const file = path.join(repo, ".devin", "mcp_config.local.json");
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.gh.env.GITHUB_TOKEN, "test-not-a-real-token");
    assert.strictEqual(git(repo, "status", "--porcelain", "--untracked-files=all").trim(), "");
    const exclude = fs.readFileSync(path.join(repo, ".git", "info", "exclude"), "utf8");
    assert.strictEqual(exclude.split(/\r?\n/).filter((l) => l === "/.devin/mcp_config.local.json").length, 1);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Devin config in a subfolder of a repo is excluded by its repo path", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-devin-"));
  try {
    git(repo, "init", "-q");
    const cwd = path.join(repo, "packages", "app");
    fs.mkdirSync(cwd, { recursive: true });
    writeDevinMcpConfig(cwd, entries);
    assert.strictEqual(git(repo, "status", "--porcelain", "--untracked-files=all").trim(), "");
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("Devin config outside a git repo is still written", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-devin-"));
  try {
    writeDevinMcpConfig(dir, entries);
    assert.ok(fs.existsSync(path.join(dir, ".devin", "mcp_config.local.json")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
