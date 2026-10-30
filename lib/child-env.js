"use strict";

// The environment JAgents gives the programs it starts: the pty daemon (and
// so every terminal), ACP agents and Claude Code chats.
//
// JAgents started from inside a Claude Code session (a terminal or the desktop
// app) inherits that session's markers; agents launched here would think they
// are its children (no transcript saving, the host's proxy and socket). They
// are dropped, and so are the values the agent host sets for its own
// non-interactive use (GIT_EDITOR=true makes `git commit` abort with no
// editor).
//
// Agent shells set NO_COLOR (and some FORCE_COLOR=0) for their own output.
// JAgents started from one passed it to every terminal, and the terminals
// lost their colors.
//
// Any of these stays when the user set it in their own Windows environment
// (for example CLAUDE_CODE_MAX_CONTEXT_TOKENS or a gateway ANTHROPIC_BASE_URL).
//
// Same rules as JWorkspace (main/child-env.cjs).

const { execFile, execFileSync } = require("node:child_process");

const SESSION_KEYS = /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.+|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE|ANTHROPIC_BASE_URL)$/;

// Values an agent host sets for its own shells; dropped only with that value.
const SESSION_VALUES = { GIT_EDITOR: /^true$/i, COREPACK_ENABLE_AUTO_PIN: /^0$/ };

// Colour switches an agent shell sets that turn colors off.
const NO_COLOR_KEYS = ["NO_COLOR", "FORCE_COLOR"];
const turnsColorOff = (key, value) => key === "NO_COLOR" || (key === "FORCE_COLOR" && /^(0|false|no)$/i.test(String(value).trim()));

const HIVES = ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"];

// The names in `reg query <hive>` output, upper case.
function regNames(text) {
  const names = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s{2,}(\S.*?)\s{2,}REG_\w+/.exec(line);
    if (m) names.add(m[1].toUpperCase());
  }
  return names;
}

// The variable names the user set in Windows. Read once, off the main
// thread: loadUserEnv() before the first spawn. A spawn before it finished
// reads them synchronously with a short timeout.
let userNames = null;
let loading = null;

function loadUserEnv() {
  if (process.platform !== "win32") return Promise.resolve();
  if (!loading) {
    loading = Promise.all(
      HIVES.map((hive) => new Promise((resolve) => execFile("reg", ["query", hive], { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(regNames(stdout))))),
    ).then((sets) => {
      if (!userNames) userNames = new Set(sets.flatMap((s) => [...s]));
    });
  }
  return loading;
}

function setInWindows(key) {
  if (!userNames) {
    userNames = new Set();
    for (const hive of HIVES) {
      try {
        for (const n of regNames(execFileSync("reg", ["query", hive], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, timeout: 1000 }))) userNames.add(n);
      } catch {
        // missing hive or timeout: treat as not set
      }
    }
  }
  return userNames.has(String(key).toUpperCase());
}

// A cleaned copy of env; env itself is left as it is. opts.platform and opts.userSet(key)
// stand in for the real ones in tests.
function cleanEnv(env, opts) {
  const o = opts || {};
  const out = Object.assign({}, env);
  delete out.ELECTRON_RUN_AS_NODE;
  const win = (o.platform || process.platform) === "win32";
  const isUserSet = o.userSet || (win ? setInWindows : () => false);
  if (out.CLAUDECODE || out.CLAUDE_CODE_ENTRYPOINT) {
    for (const key of Object.keys(out)) {
      const drop = SESSION_KEYS.test(key) || (SESSION_VALUES[key] && SESSION_VALUES[key].test(String(out[key]).trim()));
      if (drop && !isUserSet(key)) delete out[key];
    }
  }
  if (win) {
    for (const key of NO_COLOR_KEYS) if (key in out && turnsColorOff(key, out[key]) && !isUserSet(key)) delete out[key];
  }
  return out;
}

// The base for every child's environment. The desktop app cleans its own
// process.env and leaves this unset; JAgents inside another app (JWorkspace)
// sets a cleaned copy, so the host's process.env stays as it is.
let base = null;

function setChildEnv(env) {
  base = env || null;
}

function childEnv() {
  return base || process.env;
}

module.exports = { cleanEnv, loadUserEnv, regNames, setChildEnv, childEnv };
