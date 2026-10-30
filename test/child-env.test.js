"use strict";

// The environment JAgents gives the programs it starts (lib/child-env.js):
// a Claude Code session's markers and an agent shell's NO_COLOR are dropped
// from a copy, and the host's own process.env is never changed.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanEnv, regNames, setChildEnv, childEnv } = require("../lib/child-env");
const { AcpClient } = require("../lib/acp-client");

test("a Claude Code session's markers are dropped from a copy", () => {
  const env = { PATH: "C:\\bin", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SSE_PORT: "5", CLAUDE_AGENT_SDK_VERSION: "1", CLAUDE_PID: "9", ANTHROPIC_BASE_URL: "http://proxy", CLAUDE_CONFIG_DIR: "C:\\claude", ANTHROPIC_API_KEY: "k" };
  const before = JSON.stringify(env);
  const out = cleanEnv(env, { platform: "linux" });
  assert.deepStrictEqual(out, { PATH: "C:\\bin", CLAUDE_CONFIG_DIR: "C:\\claude", ANTHROPIC_API_KEY: "k" });
  assert.strictEqual(JSON.stringify(env), before, "the input is left as it is");
});

test("without a session marker the Claude variables stay", () => {
  const env = { CLAUDE_CODE_NO_FLICKER: "1", ANTHROPIC_BASE_URL: "http://proxy" };
  assert.deepStrictEqual(cleanEnv(env, { platform: "linux" }), env);
});

test("NO_COLOR goes on Windows unless the user set it there", () => {
  assert.strictEqual("NO_COLOR" in cleanEnv({ NO_COLOR: "1" }, { platform: "win32", userSet: () => false }), false);
  assert.strictEqual(cleanEnv({ NO_COLOR: "1" }, { platform: "win32", userSet: (k) => k === "NO_COLOR" }).NO_COLOR, "1");
  assert.strictEqual(cleanEnv({ NO_COLOR: "1" }, { platform: "linux" }).NO_COLOR, "1");
});

test("FORCE_COLOR=0 goes on Windows unless the user set it; FORCE_COLOR that turns color on stays", () => {
  for (const v of ["0", "false", "no"]) assert.strictEqual("FORCE_COLOR" in cleanEnv({ FORCE_COLOR: v }, { platform: "win32", userSet: () => false }), false, v);
  assert.strictEqual(cleanEnv({ FORCE_COLOR: "0" }, { platform: "win32", userSet: (k) => k === "FORCE_COLOR" }).FORCE_COLOR, "0");
  assert.strictEqual(cleanEnv({ FORCE_COLOR: "3" }, { platform: "win32", userSet: () => false }).FORCE_COLOR, "3");
});

test("the agent host's GIT_EDITOR=true and COREPACK_ENABLE_AUTO_PIN=0 are dropped in a session", () => {
  const out = cleanEnv({ CLAUDECODE: "1", GIT_EDITOR: "true", COREPACK_ENABLE_AUTO_PIN: "0" }, { platform: "win32", userSet: () => false });
  assert.deepStrictEqual(out, {});
  assert.strictEqual(cleanEnv({ CLAUDECODE: "1", GIT_EDITOR: "code --wait" }, { platform: "linux" }).GIT_EDITOR, "code --wait");
  assert.strictEqual(cleanEnv({ GIT_EDITOR: "true" }, { platform: "linux" }).GIT_EDITOR, "true");
});

test("session keys the user set in Windows stay (gateway, context window)", () => {
  const mine = ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS"];
  const env = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s", ANTHROPIC_BASE_URL: "https://gateway", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000" };
  const out = cleanEnv(env, { platform: "win32", userSet: (k) => mine.includes(k) });
  assert.deepStrictEqual(out, { ANTHROPIC_BASE_URL: "https://gateway", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "400000" });
});

test("reg query output gives the names the user set", () => {
  const text = ["", "HKEY_CURRENT_USER\\Environment", "    Path    REG_EXPAND_SZ    C:\\a", "    NO_COLOR    REG_SZ    1", ""].join("\r\n");
  assert.deepStrictEqual([...regNames(text)].sort(), ["NO_COLOR", "PATH"]);
});

test("childEnv is process.env until a host sets a cleaned copy", () => {
  assert.strictEqual(childEnv(), process.env);
  const base = { A: "1" };
  setChildEnv(base);
  try {
    assert.strictEqual(childEnv(), base);
  } finally {
    setChildEnv(null);
  }
  assert.strictEqual(childEnv(), process.env);
});

test("an ACP agent starts with the host's cleaned environment, not process.env", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-env-test-"));
  const out = path.join(dir, "env.json");
  const had = process.env.CLAUDECODE;
  process.env.CLAUDECODE = "1";
  const before = JSON.stringify(process.env);
  setChildEnv(Object.assign(cleanEnv(process.env, { platform: "linux" }), { JAGENTS_ENV_TEST: "base" }));
  try {
    const client = new AcpClient({ harnessId: "env-test", dataRoot: dir, cwd: dir });
    const script = "require('fs').writeFileSync(" + JSON.stringify(out) + ", JSON.stringify({ cc: process.env.CLAUDECODE || '', base: process.env.JAGENTS_ENV_TEST || '', spec: process.env.SPEC_VAR || '' }))";
    client.start({ command: process.execPath, args: ["-e", script], env: { SPEC_VAR: "spec" } });
    await new Promise((resolve) => client.child.once("exit", resolve));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(out, "utf8")), { cc: "", base: "base", spec: "spec" });
    assert.strictEqual(JSON.stringify(process.env), before, "process.env is not changed");
    client.stop();
  } finally {
    setChildEnv(null);
    if (had === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = had;
  }
});
