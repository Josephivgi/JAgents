"use strict";

// The environment JAgents gives the programs it starts: the pty daemon (and
// so every terminal), ACP agents and Claude Code chats.
//
// JAgents started from inside a Claude Code session (a terminal or the desktop
// app) inherits that session's markers; agents launched here would think they
// are its children (no transcript saving, the host's proxy and socket). They
// are dropped.
//
// Agent shells set NO_COLOR for their own output. JAgents started from one
// passed it to every terminal, and the terminals lost their colors. It stays
// only when the user set it in their own Windows environment.

const { execFileSync } = require("node:child_process");

const SESSION_KEYS = /^(CLAUDECODE|CLAUDE_CODE_.+|CLAUDE_AGENT_SDK_.+|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.+|MCP_CONNECTION_NONBLOCKING|MCP_SERVER_CONNECTION_BATCH_SIZE|ANTHROPIC_BASE_URL)$/;

function userSetNoColor() {
  return ["HKCU\\Environment", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"].some((key) => {
    try {
      execFileSync("reg", ["query", key, "/v", "NO_COLOR"], { stdio: "ignore", windowsHide: true });
      return true;
    } catch {
      return false;
    }
  });
}

// A cleaned copy of env; env itself is left as it is. opts.platform and
// opts.noColorUserSet() stand in for the real ones in tests.
function cleanEnv(env, opts) {
  const o = opts || {};
  const out = Object.assign({}, env);
  if (out.CLAUDECODE || out.CLAUDE_CODE_ENTRYPOINT) {
    for (const key of Object.keys(out)) if (SESSION_KEYS.test(key)) delete out[key];
  }
  if ((o.platform || process.platform) === "win32" && "NO_COLOR" in out && !(o.noColorUserSet || userSetNoColor)()) delete out.NO_COLOR;
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

module.exports = { cleanEnv, setChildEnv, childEnv };
