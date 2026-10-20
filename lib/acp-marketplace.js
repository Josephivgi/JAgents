"use strict";

// The agent marketplace: every agent in the official ACP Registry
// (cdn.agentclientprotocol.com), installable from JAgents, plus custom ACP
// commands the user types. Installed registry agents and custom agents live in
// the acp_agents table of jagents.db and join the agent picker, the + menu, and
// spawn_subagent through agents.js setExtraAgents.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { findProgram, ACP_AGENTS, LOCAL_BIN } = require("./agents");
const { isFile } = require("./win-command");

const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const REGISTRY_MAX_AGE = 6 * 60 * 60 * 1000;
const NAME_MAX = 60;
const COMMAND_MAX = 500;
const ARGS_MAX = 4000;
const CUSTOM_MAX = 40;

// Registry ids for agents JAgents already ships. Installing one from the
// registry fills in the built-in when its own install is missing.
const BUILTIN_IDS = { devin: "devin", cursor: "cursor", gemini: "gemini", "codex-acp": "codex", "github-copilot-cli": "copilot", kimi: "kimi", opencode: "opencode" };

function platformKey() {
  const os = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform] || process.platform;
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch] || process.arch;
  return os + "-" + arch;
}

function localId(registryId) {
  return BUILTIN_IDS[registryId] || registryId;
}

function safeName(id) {
  return String(id).replace(/[^a-z0-9._-]/gi, "_");
}

// --- Registry feed --------------------------------------------------------

function cacheFile(dataRoot) {
  return path.join(dataRoot, "acp-registry.json");
}

function iconDir(dataRoot) {
  return path.join(dataRoot, "registry-icons");
}

function readCache(dataRoot) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(dataRoot), "utf8"));
  } catch {
    return null;
  }
}

async function fetchText(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms || 20000), headers: { "user-agent": "JAgents" } });
  if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
  return res.text();
}

// Icons are cached as files and sent to the page as data: URIs (the page's CSP
// allows no remote images). They render through <img>, so an SVG cannot run
// script.
async function cacheIcons(dataRoot, agents) {
  const dir = iconDir(dataRoot);
  fs.mkdirSync(dir, { recursive: true });
  await Promise.all(
    agents.map(async (a) => {
      const file = path.join(dir, safeName(a.id) + ".svg");
      if (!a.icon || !/^https:\/\//.test(a.icon) || isFile(file)) return;
      try {
        const svg = await fetchText(a.icon, 10000);
        if (svg.length < 200000 && /<svg[\s>]/i.test(svg)) fs.writeFileSync(file, svg);
      } catch {
        /* the row falls back to a generic glyph */
      }
    }),
  );
}

function iconData(dataRoot, id) {
  try {
    return "data:image/svg+xml;base64," + fs.readFileSync(path.join(iconDir(dataRoot), safeName(id) + ".svg")).toString("base64");
  } catch {
    return "";
  }
}

// The registry, fetched at most every six hours. Offline, the last copy is
// used and the panel says so.
async function loadRegistry(dataRoot, force) {
  const cached = readCache(dataRoot);
  if (!force && cached && Date.now() - cached.fetchedAt < REGISTRY_MAX_AGE) return cached;
  try {
    const data = JSON.parse(await fetchText(REGISTRY_URL));
    if (!data || !Array.isArray(data.agents)) throw new Error("the registry answered with no agent list");
    const out = { fetchedAt: Date.now(), agents: data.agents };
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.writeFileSync(cacheFile(dataRoot), JSON.stringify(out));
    await cacheIcons(dataRoot, data.agents);
    return out;
  } catch (error) {
    if (cached) return Object.assign({}, cached, { error: "Could not refresh the registry (" + error.message + "). Showing the copy from " + new Date(cached.fetchedAt).toLocaleString() + "." });
    throw new Error("Could not load the ACP Registry: " + error.message);
  }
}

// How this computer can run a registry agent: a prebuilt binary for this
// platform, an npm package, or a uv package. Binaries come first for agents
// that offer both because they need no runtime.
function pickDistribution(agent) {
  const dist = agent.distribution || {};
  const bin = dist.binary && dist.binary[platformKey()];
  if (bin && bin.archive && bin.cmd) return { kind: "binary", archive: bin.archive, sha256: bin.sha256 || "", cmd: bin.cmd, args: bin.args || [], env: bin.env || {} };
  if (dist.npx && dist.npx.package) return { kind: "npm", pkg: dist.npx.package, args: dist.npx.args || [], env: dist.npx.env || {} };
  if (dist.uvx && dist.uvx.package) return { kind: "uv", pkg: dist.uvx.package, args: dist.uvx.args || [], env: dist.uvx.env || {} };
  return null;
}

function distLabel(d) {
  if (d.kind === "npm") return "npm " + d.pkg;
  if (d.kind === "uv") return "uv " + d.pkg;
  return d.archive.replace(/^.*\//, "");
}

// --- Saved agents ---------------------------------------------------------

function rows(db) {
  try {
    return db.listAcpAgents();
  } catch {
    return [];
  }
}

function argsLabel(row) {
  return row.command + (row.args.length ? " " + row.args.join(" ") : "");
}

function resolves(agent) {
  try {
    return Boolean(agent && agent.resolve());
  } catch {
    return false;
  }
}

// What the marketplace panel draws: every registry agent with its install
// state, the built-ins the registry does not list, and the custom agents.
async function marketplaceList(db, dataRoot, options) {
  const reg = await loadRegistry(dataRoot, options && options.refresh);
  const byId = new Map(rows(db).map((r) => [r.id, r]));
  const builtIns = new Map(ACP_AGENTS.map((a) => [a.id, a]));
  const listed = new Set();
  const agents = [];
  for (const a of reg.agents) {
    const id = localId(a.id);
    listed.add(id);
    const row = byId.get(id);
    const managed = Boolean(row && row.kind === "registry");
    const onSystem = resolves(builtIns.get(id));
    const dist = pickDistribution(a);
    agents.push({
      id,
      name: a.name || a.id,
      description: a.description || "",
      version: a.version || "",
      authors: (a.authors || []).join(", "),
      license: a.license || "",
      website: /^https:\/\//.test(a.website || "") ? a.website : "",
      repository: /^https:\/\//.test(a.repository || "") ? a.repository : "",
      icon: iconData(dataRoot, a.id),
      builtIn: builtIns.has(id),
      installed: managed || onSystem,
      managed,
      installedVersion: managed ? row.version : "",
      update: Boolean(managed && a.version && row.version && row.version !== a.version),
      canInstall: Boolean(dist),
      how: dist ? distLabel(dist) : "No build for " + platformKey(),
    });
  }
  for (const a of ACP_AGENTS) {
    if (listed.has(a.id)) continue;
    const found = resolves(a);
    agents.push({ id: a.id, name: a.name, description: a.description, version: "", authors: "", license: "", website: "", repository: "", icon: "", builtIn: true, native: Boolean(a.native), installed: found, managed: false, installedVersion: "", update: false, canInstall: !found && Boolean(a.setup), how: a.setup ? "Official installer" : "" });
  }
  agents.sort((x, y) => x.name.localeCompare(y.name, undefined, { sensitivity: "base" }));
  return {
    fetchedAt: reg.fetchedAt,
    error: reg.error || "",
    platform: platformKey(),
    agents,
    custom: rows(db)
      .filter((r) => r.kind === "custom" && r.command)
      .map((r) => ({ id: r.id, name: r.name, commandLabel: argsLabel(r), available: Boolean(findProgram(r.command, [LOCAL_BIN])) })),
  };
}

// The install plan for one marketplace row: a registry distribution, or a
// built-in's official installer.
function installPlan(dataRoot, id) {
  const reg = readCache(dataRoot);
  const entry = reg && reg.agents.find((a) => localId(a.id) === id);
  if (entry) {
    const dist = pickDistribution(entry);
    if (!dist) throw new Error(entry.name + " has no build for this computer.");
    return { id, name: entry.name || entry.id, version: entry.version || "", dist, dir: path.join(dataRoot, "agents", safeName(id)) };
  }
  const builtIn = ACP_AGENTS.find((a) => a.id === id);
  if (builtIn && builtIn.setup) return { id, name: builtIn.name, version: "", dist: Object.assign({ kind: "script" }, builtIn.setup), dir: "" };
  throw new Error("Unknown agent: " + id);
}

function saveInstalled(db, plan, spec) {
  db.removeAcpAgent(plan.id);
  db.addAcpAgent({ id: plan.id, kind: "registry", name: plan.name, command: spec.command, args: spec.args, env: spec.env, version: plan.version });
}

function removeAgent(db, dataRoot, id) {
  const key = String(id || "");
  if (!key) throw new Error("Missing agent id.");
  const row = rows(db).find((r) => r.id === key);
  if (!row) return false;
  db.removeAcpAgent(key);
  if (row.kind === "registry") {
    try {
      fs.rmSync(path.join(dataRoot, "agents", safeName(key)), { recursive: true, force: true });
    } catch {
      /* a file still held open; a reinstall reuses the folder */
    }
  }
  return true;
}

// --- Custom agents --------------------------------------------------------

// Splits an args field on whitespace, honoring double and single quotes.
function splitArgs(text) {
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(text || "")))) out.push(match[1] != null ? match[1] : match[2] != null ? match[2] : match[3]);
  return out;
}

function addCustomAgent(db, body) {
  const input = body && typeof body === "object" ? body : {};
  const name = String(input.name || "").trim();
  const command = String(input.command || "").trim().replace(/^"+|"+$/g, "");
  const args = Array.isArray(input.args) ? input.args.map((item) => String(item)) : splitArgs(input.args);
  if (!name || name.length > NAME_MAX) throw new Error("Name the agent (60 characters or fewer).");
  // A bare word resolves through PATH; a spaced command must be a full path.
  if (!command || command.length > COMMAND_MAX || (/\s/.test(command) && !path.isAbsolute(command))) {
    throw new Error("Give the agent command: one program name or a full path. Paths with spaces need no quotes.");
  }
  if (/\.ps1$/i.test(command)) throw new Error("PowerShell scripts cannot run as ACP agents; wrap the call in a .cmd or .exe.");
  const nogoExt = process.platform === "win32" ? /\.(vbs|wsf|hta|py|sh|js)$/i : /\.(vbs|wsf|hta)$/i;
  if (nogoExt.test(command)) throw new Error("That kind of file cannot run as an ACP agent; use an .exe, .cmd, or a bare command name.");
  if (JSON.stringify(args).length > ARGS_MAX) throw new Error("The argument list is too long.");
  // A .cmd agent runs through cmd.exe, where these become operators.
  if (args.some((arg) => /[&|<>%"^\r\n]/.test(arg))) throw new Error("Arguments cannot contain &, |, <, >, \", %, ^, or line breaks.");
  const customs = rows(db).filter((r) => r.kind === "custom");
  if (customs.length >= CUSTOM_MAX) throw new Error("The agent list is full.");
  // A retried Add would otherwise mint a twin.
  const dup = customs.find((r) => r.command === command && JSON.stringify(r.args) === JSON.stringify(args));
  if (dup) return { id: dup.id, name: dup.name, existing: true };
  const id = "custom-" + randomUUID().slice(0, 8);
  db.addAcpAgent({ id, kind: "custom", name, command, args });
  return { id, name };
}

// --- Picker entries -------------------------------------------------------

// Agent definitions in the shape of agents.js ACP_AGENTS. A registry agent
// runs the exact command saved at install time; a custom one resolves only
// when its typed command is found.
function extraAgents(db) {
  const out = [];
  for (const row of rows(db)) {
    if (row.kind === "registry" && row.command) {
      out.push({
        id: row.id,
        name: row.name,
        description: "From the ACP Registry" + (row.version ? ", version " + row.version : "") + ".",
        resolve: () => (path.isAbsolute(row.command) && !isFile(row.command) ? null : { command: row.command, args: row.args.slice(), env: Object.assign({}, row.env) }),
        install: "Its files are missing. Install it again from the agent marketplace.",
        marketplace: true,
      });
    } else if (row.kind === "custom" && row.command) {
      out.push({
        id: row.id,
        name: row.name,
        description: "Custom ACP agent: " + argsLabel(row),
        resolve: () => {
          const command = findProgram(row.command, [LOCAL_BIN]);
          return command ? { command, args: row.args.slice(), env: {} } : null;
        },
        install: "The command " + row.command + " was not found. Fix it or remove the agent in the agent marketplace.",
        marketplace: true,
        custom: true,
      });
    }
  }
  return out;
}

module.exports = { REGISTRY_URL, BUILTIN_IDS, platformKey, loadRegistry, pickDistribution, marketplaceList, installPlan, saveInstalled, removeAgent, addCustomAgent, extraAgents, splitArgs };
