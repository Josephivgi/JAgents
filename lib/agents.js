"use strict";

// Every agent JAgents can run, in two families:
//  - terminal agents: an interactive CLI in a real PTY (Claude Code, Codex, a shell).
//  - ACP agents: driven over the Agent Client Protocol in a chat pane. These are
//    also what the MCP hub spawns as subagents.
// The ACP resolvers follow Plugin App's acp-marketplace.js (cursor's versioned
// node.exe, npm .cmd shims unwrapped, .ps1 shims skipped).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveProgram, isFile, spawnArgv } = require("./win-command");

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function npmGlobalDir() {
  if (process.platform === "win32") return process.env.APPDATA ? path.join(process.env.APPDATA, "npm") : "";
  return "/usr/local/bin";
}

const RESOLVE_CACHE_MS = 15000;
const resolveCache = new Map();

function findProgram(names, extraDirs) {
  const key = JSON.stringify([names, extraDirs]);
  const hit = resolveCache.get(key);
  if (hit && hit.at > Date.now() - RESOLVE_CACHE_MS) return hit.value;
  const value = findProgramUncached(names, extraDirs);
  resolveCache.set(key, { at: Date.now(), value });
  return value;
}

function findProgramUncached(names, extraDirs) {
  const list = Array.isArray(names) ? names : [names];
  const dirs = [npmGlobalDir()].concat(extraDirs || []).filter(Boolean);
  for (const name of list) {
    const raw = String(name || "").trim();
    if (!raw) continue;
    if (path.isAbsolute(raw)) {
      if (isFile(raw) && !/\.ps1$/i.test(raw)) return raw;
      continue;
    }
    const onPath = resolveProgram(raw);
    if (onPath && onPath !== raw) return onPath;
    for (const dir of dirs) {
      for (const candidate of process.platform === "win32" ? [raw + ".cmd", raw + ".exe", raw] : [raw]) {
        const file = path.join(dir, candidate);
        if (isFile(file) && !/\.ps1$/i.test(file)) return file;
      }
    }
  }
  return null;
}

// uv, pipx, and the Claude Code installer put programs here.
const LOCAL_BIN = path.join(os.homedir(), ".local", "bin");

function clearResolveCache() {
  resolveCache.clear();
}

function programSpec(names, args, extraDirs) {
  const command = findProgram(names, [LOCAL_BIN].concat(extraDirs || []));
  return command ? { command, args: (args || []).slice(), env: {} } : null;
}

function versionKey(name) {
  return (String(name).match(/\d+/g) || []).slice(0, 6).map((d) => d.padStart(4, "0")).join("");
}

// The Cursor CLI ships node.exe + index.js per version; its .ps1 shim picks the
// newest folder. Doing the same avoids spawning PowerShell.
function cursorAgentSpec(args) {
  const root = path.join(localAppData(), "cursor-agent", "versions");
  try {
    const versions = fs
      .readdirSync(root)
      .filter((v) => isFile(path.join(root, v, "node.exe")) && isFile(path.join(root, v, "index.js")))
      .sort((a, b) => (versionKey(a) < versionKey(b) ? 1 : -1));
    if (versions.length) {
      const dir = path.join(root, versions[0]);
      return { command: path.join(dir, "node.exe"), args: [path.join(dir, "index.js")].concat(args), env: { CURSOR_INVOKED_AS: "cursor-agent" } };
    }
  } catch {
    /* fall through to PATH */
  }
  return programSpec("cursor-agent", args);
}

function devinSpec() {
  const bundled = path.join(localAppData(), "devin", "cli", "bin", process.platform === "win32" ? "devin.exe" : "devin");
  if (isFile(bundled)) return { command: bundled, args: ["acp"], env: {} };
  return programSpec("devin", ["acp"]);
}

// Native Claude chats run the installed claude CLI (same sign-in and version as
// the terminal) through the Agent SDK; without it, the SDK's bundled binary.
function claudeNativeSpec() {
  const cli = programSpec("claude", [], [path.join(os.homedir(), ".local", "bin")]);
  if (cli && /\.(exe|js|mjs|cjs)$/i.test(cli.command)) return cli;
  try {
    require.resolve("@anthropic-ai/claude-agent-sdk-" + process.platform + "-" + process.arch + "/package.json");
    return { command: "", args: [], env: {} };
  } catch {
    return cli;
  }
}

// Chat agents: chat panes and subagents. Most speak ACP; `native` ones have
// their own client (Claude Code through the Agent SDK).
const ACP_AGENTS = [
  { id: "devin", name: "Devin", description: "Devin CLI over ACP.", resolve: devinSpec, install: "Install the Devin CLI, then run devin auth login." },
  { id: "cursor", name: "Cursor", description: "Cursor CLI agent over ACP.", resolve: () => cursorAgentSpec(["acp"]), install: "Install the Cursor CLI, then run cursor-agent login." },
  {
    id: "claude-code",
    aliases: ["claude"],
    name: "Claude Code",
    description: "Claude Code through the Claude Agent SDK (native, no ACP adapter).",
    native: "claude-sdk",
    resolve: claudeNativeSpec,
    install: "Install Claude Code: irm https://claude.ai/install.ps1 | iex",
    setup: { kind: "script", ps: "irm https://claude.ai/install.ps1 | iex", sh: "curl -fsSL https://claude.ai/install.sh | bash" },
  },
  {
    id: "codex",
    name: "Codex (ACP)",
    description: "OpenAI Codex through its ACP adapter.",
    resolve: () => programSpec("codex-acp", [], [path.join(os.homedir(), ".cargo", "bin")]),
    install: "npm install -g @agentclientprotocol/codex-acp",
    npm: "@agentclientprotocol/codex-acp",
  },
  { id: "gemini", name: "Gemini CLI", description: "Google Gemini CLI over ACP.", resolve: () => programSpec("gemini", ["--acp"]), install: "npm install -g @google/gemini-cli" },
  { id: "opencode", name: "OpenCode", description: "OpenCode over ACP.", resolve: () => programSpec("opencode", ["acp"]), install: "npm install -g opencode-ai" },
  { id: "copilot", name: "GitHub Copilot CLI", description: "Copilot CLI over ACP.", resolve: () => programSpec("copilot", ["--acp", "--stdio"]), install: "npm install -g @github/copilot" },
  { id: "kimi", name: "Kimi CLI", description: "Kimi CLI over ACP.", resolve: () => programSpec("kimi", ["acp"]), install: "uv tool install kimi-cli" },
];

// Marketplace agents (lib/acp-marketplace.js) join the built-ins here. main.cjs
// sets the source once the database is open.
let extraSource = () => [];
function setExtraAgents(fn) {
  extraSource = typeof fn === "function" ? fn : () => [];
}

function allAcpAgents() {
  let extras = [];
  try {
    extras = extraSource() || [];
  } catch {
    /* a broken store must not hide the built-ins */
  }
  const byId = new Map(extras.filter((a) => a && a.id).map((a) => [a.id, a]));
  // A built-in installed from the marketplace runs that copy when the
  // system has none of its own.
  const builtIns = ACP_AGENTS.map((a) => {
    const extra = byId.get(a.id);
    if (!extra) return a;
    byId.delete(a.id);
    return Object.assign({}, a, { resolve: () => safeResolve(a) || safeResolve(extra) });
  });
  const taken = new Set(ACP_AGENTS.flatMap((a) => [a.id].concat(a.aliases || [])));
  return builtIns.concat(Array.from(byId.values()).filter((a) => !taken.has(a.id)));
}

function safeResolve(item) {
  try {
    return item.resolve() || null;
  } catch {
    return null;
  }
}

function acpAgent(id) {
  const key = String(id || "").toLowerCase();
  const all = allAcpAgents();
  return all.find((a) => a.id === key) || all.find((a) => (a.aliases || []).includes(key)) || null;
}

function listAcpAgents() {
  return allAcpAgents().map((a) => {
    const spec = safeResolve(a);
    return { id: a.id, name: a.name, description: a.description, native: a.native || "", available: Boolean(spec), command: spec ? spec.command : "", install: spec ? "" : a.install, npm: a.npm || "", marketplace: Boolean(a.marketplace), custom: Boolean(a.custom) };
  });
}

function acpSpawnSpec(id) {
  const agent = acpAgent(id);
  if (!agent) throw new Error("Unknown ACP agent: " + id);
  const spec = safeResolve(agent);
  if (!spec) throw new Error(agent.name + " is not installed. " + agent.install);
  return spec;
}

// Terminal agents: interactive CLIs in a PTY.
function shellSpec() {
  if (process.platform !== "win32") return { command: process.env.SHELL || "/bin/bash", args: [], env: {} };
  const pwsh = resolveProgram("pwsh");
  if (pwsh && pwsh !== "pwsh") return { command: pwsh, args: ["-NoLogo"], env: {} };
  return { command: "powershell.exe", args: ["-NoLogo"], env: {} };
}

const TERMINAL_AGENTS = [
  { id: "claude", name: "Claude Code", description: "claude in a terminal", resolve: () => programSpec("claude", [], [path.join(os.homedir(), ".local", "bin")]), install: "Install Claude Code: irm https://claude.ai/install.ps1 | iex" },
  { id: "codex", name: "Codex", description: "codex in a terminal", resolve: () => programSpec("codex", []), install: "npm install -g @openai/codex" },
  { id: "cursor-agent", name: "Cursor Agent", description: "cursor-agent in a terminal", resolve: () => cursorAgentSpec([]), install: "Install the Cursor CLI." },
  { id: "devin-cli", name: "Devin CLI", description: "devin in a terminal", resolve: () => { const s = devinSpec(); return s ? { command: s.command, args: [], env: {} } : null; }, install: "Install the Devin CLI." },
  { id: "shell", name: "Shell", description: "a plain shell", resolve: shellSpec, install: "" },
];

function terminalAgent(id) {
  return TERMINAL_AGENTS.find((a) => a.id === id) || null;
}

function listTerminalAgents() {
  return TERMINAL_AGENTS.map((a) => {
    const spec = safeResolve(a);
    return { id: a.id, name: a.name, description: a.description, available: Boolean(spec), install: spec ? "" : a.install };
  });
}

// node-pty needs a real executable, so npm .cmd shims (codex) are unwrapped to
// `node entry.js` the same way spawnHidden does for ACP agents.
function terminalSpawnSpec(id, extraArgs) {
  const agent = terminalAgent(id);
  if (!agent) throw new Error("Unknown terminal agent: " + id);
  const spec = safeResolve(agent);
  if (!spec) throw new Error(agent.name + " is not installed. " + agent.install);
  const argv = spawnArgv(spec.command, spec.args.concat(extraArgs || []));
  if (argv.shell) return { command: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", argv.command].concat(argv.args), env: spec.env };
  return { command: argv.command, args: argv.args, env: spec.env };
}

function nodePath() {
  const onPath = resolveProgram("node");
  return onPath && onPath !== "node" && isFile(onPath) ? onPath : "";
}

module.exports = { ACP_AGENTS, TERMINAL_AGENTS, LOCAL_BIN, clearResolveCache, setExtraAgents, acpAgent, listAcpAgents, acpSpawnSpec, terminalAgent, listTerminalAgents, terminalSpawnSpec, nodePath, findProgram };
