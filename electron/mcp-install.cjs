"use strict";

// Global installs of the JAgents MCP server into each agent's own config, so
// agents started outside JAgents can reach it too. Claude Code and Codex go
// through their own `mcp add/remove` commands; Cursor and Gemini keep a JSON
// file, which is merged (other servers are left alone).
//
// Auto MCP (autoUpdate) runs at startup and every few minutes: it repairs
// installs that point at an old script or node and, when the user turned it
// on, installs into every supported agent that is on this computer. Old
// "relay" entries are left alone; importLegacyMcp adds jagents next to them
// when the user imports from legacy Relay.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { findProgram, nodePath, listAcpAgents, listTerminalAgents } = require("../lib/agents");
const { spawnArgv } = require("../lib/win-command");

const NAME = "jagents";
const LEGACY = "relay";

function home() {
  return os.homedir();
}

function claudeConfigFile() {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home(), ".claude.json");
}

function codexConfigFile() {
  return path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "config.toml");
}

function claudeProgram() {
  return findProgram("claude", [path.join(home(), ".local", "bin")]);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read " + file + ": " + error.message);
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".jagents-" + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function run(program, args) {
  return new Promise((resolve, reject) => {
    const argv = spawnArgv(program, args);
    execFile(argv.command, argv.args, { windowsHide: true, timeout: 60000, shell: Boolean(argv.shell) }, (err, stdout, stderr) => {
      if (err) return reject(new Error((String(stderr || stdout || "").trim() || err.message).slice(0, 600)));
      resolve(String(stdout || "").trim());
    });
  });
}

function serverCommand(scriptPath) {
  const node = nodePath();
  return node ? { command: node, args: [scriptPath], env: {} } : { command: process.execPath, args: [scriptPath], env: { ELECTRON_RUN_AS_NODE: "1" } };
}

// An install is current when it runs this script with the node we would pick now.
function sameEntry(entry, script) {
  if (!entry) return false;
  const want = serverCommand(script);
  const args = Array.isArray(entry.args) ? entry.args : [];
  return path.resolve(String(entry.command || "")) === path.resolve(want.command) && args.length === 1 && path.resolve(String(args[0])) === path.resolve(script);
}

// TOML table [mcp_servers.<name>] as text, up to the next table.
function tomlTable(text, name) {
  const m = new RegExp("^\\s*\\[mcp_servers\\." + name + "\\]\\s*$", "m").exec(text);
  if (!m) return null;
  const rest = text.slice(m.index + m[0].length);
  const next = /^\s*\[/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function tomlMentions(table, file) {
  const unescaped = table.replace(/\\\\/g, "\\");
  return unescaped.includes(file);
}

function jsonTarget(id, name, fileFn, programs) {
  const servers = () => {
    const cfg = readJson(fileFn());
    return (cfg && cfg.mcpServers) || {};
  };
  return {
    id,
    name,
    available: () => Boolean(findProgram(programs)) || fs.existsSync(path.dirname(fileFn())),
    where: fileFn,
    installed: () => Boolean(servers()[NAME]),
    current: (script) => sameEntry(servers()[NAME], script),
    legacy: () => Boolean(servers()[LEGACY]),
    async install(script) {
      const file = fileFn();
      const cfg = readJson(file) || {};
      if (typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(file + " is not a JSON object; it was not changed.");
      const s = serverCommand(script);
      cfg.mcpServers = Object.assign({}, cfg.mcpServers, { [NAME]: { command: s.command, args: s.args, env: s.env } });
      writeJsonAtomic(file, cfg);
    },
    async uninstall(which) {
      const key = which || NAME;
      const file = fileFn();
      const cfg = readJson(file);
      if (!cfg || !cfg.mcpServers || !cfg.mcpServers[key]) return;
      delete cfg.mcpServers[key];
      writeJsonAtomic(file, cfg);
    },
  };
}

const TARGETS = [
  {
    id: "claude",
    name: "Claude Code",
    available: () => Boolean(claudeProgram()),
    where: claudeConfigFile,
    installed() {
      const cfg = readJson(claudeConfigFile());
      return Boolean(cfg && cfg.mcpServers && cfg.mcpServers[NAME]);
    },
    current(script) {
      const cfg = readJson(claudeConfigFile());
      return sameEntry(cfg && cfg.mcpServers && cfg.mcpServers[NAME], script);
    },
    legacy() {
      const cfg = readJson(claudeConfigFile());
      return Boolean(cfg && cfg.mcpServers && cfg.mcpServers[LEGACY]);
    },
    async install(script) {
      const s = serverCommand(script);
      const envArgs = [];
      for (const [k, v] of Object.entries(s.env)) envArgs.push("-e", k + "=" + v);
      try {
        await run(claudeProgram(), ["mcp", "remove", NAME, "-s", "user"]);
      } catch {
        /* not there yet */
      }
      await run(claudeProgram(), ["mcp", "add", NAME, "-s", "user"].concat(envArgs, ["--", s.command], s.args));
    },
    async uninstall(which) {
      await run(claudeProgram(), ["mcp", "remove", which || NAME, "-s", "user"]);
    },
  },
  {
    id: "codex",
    name: "Codex",
    available: () => Boolean(findProgram("codex")),
    where: codexConfigFile,
    installed: () => tomlTable(readText(codexConfigFile()), NAME) !== null,
    current(script) {
      const table = tomlTable(readText(codexConfigFile()), NAME);
      return table !== null && tomlMentions(table, script) && tomlMentions(table, serverCommand(script).command);
    },
    legacy: () => tomlTable(readText(codexConfigFile()), LEGACY) !== null,
    async install(script) {
      const s = serverCommand(script);
      const envArgs = [];
      for (const [k, v] of Object.entries(s.env)) envArgs.push("--env", k + "=" + v);
      try {
        await run("codex", ["mcp", "remove", NAME]);
      } catch {
        /* not there yet */
      }
      await run("codex", ["mcp", "add", NAME].concat(envArgs, ["--", s.command], s.args));
    },
    async uninstall(which) {
      await run("codex", ["mcp", "remove", which || NAME]);
    },
  },
  jsonTarget("cursor", "Cursor", () => path.join(home(), ".cursor", "mcp.json"), ["cursor-agent", "cursor"]),
  jsonTarget("gemini", "Gemini CLI", () => path.join(home(), ".gemini", "settings.json"), ["gemini"]),
];

function status(script) {
  return TARGETS.map((t) => {
    let installed = false;
    let current = false;
    let error = "";
    try {
      installed = t.installed();
      current = installed && Boolean(script) && t.current(script);
    } catch (e) {
      error = e.message;
    }
    return { id: t.id, name: t.name, available: t.available(), installed, current, where: t.where(), error };
  });
}

async function install(id, script) {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new Error("Unknown agent " + id);
  await t.install(script);
  return status(script);
}

async function uninstall(id, script) {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new Error("Unknown agent " + id);
  await t.uninstall();
  return status(script);
}

// One Auto MCP pass. Returns what it changed, for the hub panel and the log.
let running = null;
function autoUpdate(script, opts) {
  if (running) return running;
  const installMissing = Boolean(opts && opts.installMissing);
  running = (async () => {
    const changes = [];
    for (const t of TARGETS) {
      try {
        if (!t.available()) continue;
        if (t.installed()) {
          if (!t.current(script)) {
            await t.install(script);
            changes.push({ id: t.id, action: "updated" });
          }
        } else if (installMissing) {
          await t.install(script);
          changes.push({ id: t.id, action: "installed" });
        }
      } catch (error) {
        changes.push({ id: t.id, action: "failed", error: String(error.message || error) });
      }
    }
    return { at: Date.now(), changes };
  })().finally(() => (running = null));
  return running;
}

// How each kind of agent gets the JAgents MCP server, for the hub panel and
// the Help guide. "auto" means JAgents wires it up at launch with no install.
function support() {
  const acp = listAcpAgents();
  const term = listTerminalAgents();
  const t = (id) => term.find((x) => x.id === id) || { available: false };
  const rows = [
    { id: "claude", where: "Terminal", name: "Claude Code", how: "Per launch with --mcp-config", mode: "auto", available: t("claude").available },
    { id: "codex", where: "Terminal", name: "Codex", how: "Per launch with -c mcp_servers overrides", mode: "auto", available: t("codex").available },
    { id: "devin", where: "Terminal", name: "Devin CLI", how: "Per launch through .devin/mcp_config.local.json in the working folder", mode: "auto", available: t("devin-cli").available },
    { id: "cursor", where: "Terminal", name: "Cursor Agent", how: "Through the global install in ~/.cursor/mcp.json", mode: "global", available: t("cursor-agent").available },
  ];
  for (const a of acp) {
    rows.push({
      id: a.id,
      where: "Chat",
      name: a.name,
      how: a.native ? "Claude Agent SDK mcpServers, every session" : a.id === "devin" ? "ACP session plus .devin/mcp_config.local.json" : "ACP session/new mcpServers, every session",
      mode: "auto",
      available: a.available,
    });
  }
  return rows;
}

// Part of "Import from legacy Relay": every agent whose config has the old
// relay server gets the jagents server too. The relay entry stays until the
// user removes it.
async function importLegacyMcp(script) {
  const out = [];
  for (const t of TARGETS) {
    try {
      if (!t.legacy()) continue;
      if (t.installed() && t.current(script)) out.push({ id: t.id, action: "already had jagents" });
      else {
        await t.install(script);
        out.push({ id: t.id, action: "added jagents" });
      }
    } catch (error) {
      out.push({ id: t.id, action: "failed", error: String(error.message || error) });
    }
  }
  return out;
}

module.exports = { status, install, uninstall, autoUpdate, support, importLegacyMcp, NAME };
