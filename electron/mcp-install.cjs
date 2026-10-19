"use strict";

// Optional global installs of the Relay MCP server into each agent's own
// config, so agents started outside Relay can reach it too. Nothing here runs
// unless the user presses Install in the MCP hub panel. Claude Code and Codex
// go through their own `mcp add/remove` commands; Cursor and Gemini keep a
// JSON file, which is merged (other servers are left alone).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { findProgram, nodePath } = require("../lib/agents");
const { spawnArgv } = require("../lib/win-command");

const NAME = "relay";

function home() {
  return os.homedir();
}

function claudeConfigFile() {
  return process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home(), ".claude.json");
}

function codexConfigFile() {
  return path.join(process.env.CODEX_HOME || path.join(home(), ".codex"), "config.toml");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Cannot read " + file + ": " + error.message);
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".relay-" + process.pid + ".tmp";
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

function jsonTarget(id, name, fileFn, programs) {
  return {
    id,
    name,
    available: () => Boolean(findProgram(programs)) || fs.existsSync(path.dirname(fileFn())),
    where: fileFn,
    installed() {
      const cfg = readJson(fileFn());
      return Boolean(cfg && cfg.mcpServers && cfg.mcpServers[NAME]);
    },
    async install(script) {
      const file = fileFn();
      const cfg = readJson(file) || {};
      if (typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(file + " is not a JSON object; it was not changed.");
      const s = serverCommand(script);
      cfg.mcpServers = Object.assign({}, cfg.mcpServers, { [NAME]: { command: s.command, args: s.args, env: s.env } });
      writeJsonAtomic(file, cfg);
    },
    async uninstall() {
      const file = fileFn();
      const cfg = readJson(file);
      if (!cfg || !cfg.mcpServers || !cfg.mcpServers[NAME]) return;
      delete cfg.mcpServers[NAME];
      writeJsonAtomic(file, cfg);
    },
  };
}

const TARGETS = [
  {
    id: "claude",
    name: "Claude Code",
    available: () => Boolean(findProgram("claude", [path.join(home(), ".local", "bin")])),
    where: claudeConfigFile,
    installed() {
      const cfg = readJson(claudeConfigFile());
      return Boolean(cfg && cfg.mcpServers && cfg.mcpServers[NAME]);
    },
    async install(script) {
      const s = serverCommand(script);
      const claude = findProgram("claude", [path.join(home(), ".local", "bin")]);
      const envArgs = [];
      for (const [k, v] of Object.entries(s.env)) envArgs.push("-e", k + "=" + v);
      try {
        await run(claude, ["mcp", "remove", NAME, "-s", "user"]);
      } catch {
        /* not there yet */
      }
      await run(claude, ["mcp", "add", NAME, "-s", "user"].concat(envArgs, ["--", s.command], s.args));
    },
    async uninstall() {
      await run(findProgram("claude", [path.join(home(), ".local", "bin")]), ["mcp", "remove", NAME, "-s", "user"]);
    },
  },
  {
    id: "codex",
    name: "Codex",
    available: () => Boolean(findProgram("codex")),
    where: codexConfigFile,
    installed() {
      try {
        return /^\s*\[mcp_servers\.relay\]\s*$/m.test(fs.readFileSync(codexConfigFile(), "utf8"));
      } catch {
        return false;
      }
    },
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
    async uninstall() {
      await run("codex", ["mcp", "remove", NAME]);
    },
  },
  jsonTarget("cursor", "Cursor", () => path.join(home(), ".cursor", "mcp.json"), ["cursor-agent", "cursor"]),
  jsonTarget("gemini", "Gemini CLI", () => path.join(home(), ".gemini", "settings.json"), ["gemini"]),
];

function status() {
  return TARGETS.map((t) => {
    let installed = false;
    let error = "";
    try {
      installed = t.installed();
    } catch (e) {
      error = e.message;
    }
    return { id: t.id, name: t.name, available: t.available(), installed, where: t.where(), error };
  });
}

async function install(id, script) {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new Error("Unknown agent " + id);
  await t.install(script);
  return status();
}

async function uninstall(id) {
  const t = TARGETS.find((x) => x.id === id);
  if (!t) throw new Error("Unknown agent " + id);
  await t.uninstall();
  return status();
}

module.exports = { status, install, uninstall };
