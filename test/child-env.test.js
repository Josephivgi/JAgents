"use strict";

// The environment JAgents gives the programs it starts (lib/child-env.js):
// a Claude Code session's markers and an agent shell's NO_COLOR are dropped
// from a copy, and the host's own process.env is never changed.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { cleanEnv, setChildEnv, childEnv } = require("../lib/child-env");
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
  assert.strictEqual("NO_COLOR" in cleanEnv({ NO_COLOR: "1" }, { platform: "win32", noColorUserSet: () => false }), false);
  assert.strictEqual(cleanEnv({ NO_COLOR: "1" }, { platform: "win32", noColorUserSet: () => true }).NO_COLOR, "1");
  assert.strictEqual(cleanEnv({ NO_COLOR: "1" }, { platform: "linux" }).NO_COLOR, "1");
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
