"use strict";

// The workspace: every pane (terminal or chat), its handle (claude-1, devin-2),
// the Code-mode layout, and how terminal agents are launched with the JAgents
// MCP server attached. Panes persist in jagents.db; terminals relaunch fresh on
// restart, chats resume through session/load when the agent supports it.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { terminalAgent, terminalSpawnSpec, acpAgent, nodePath } = require("../lib/agents");

function tomlLiteral(value) {
  // TOML literal strings take Windows paths as-is; a single quote cannot
  // appear inside one, so fall back to a basic string for that case.
  const v = String(value);
  return v.includes("'") ? JSON.stringify(v) : "'" + v + "'";
}

// "server.tool" names (plugin disableTools) as Claude Code tool names.
function claudeToolName(name) {
  const dot = name.indexOf(".");
  return dot > 0 ? "mcp__" + name.slice(0, dot) + "__" + name.slice(dot + 1) : name;
}

function createWorkspace({ db, dataRoot, ptyHost, acpHost, emit, hubFiles, pluginMcp }) {
  let panes = (db.getSetting("panes", []) || []).filter((p) => p && p.id && p.kind);
  const counters = db.getSetting("handle-counters", {}) || {};

  function save() {
    db.setSetting("panes", panes);
    emit("panes-changed", list());
  }

  function nextHandle(provider) {
    const base = String(provider || "agent").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    counters[base] = (counters[base] || 0) + 1;
    db.setSetting("handle-counters", counters);
    return base + "-" + counters[base];
  }

  function hubOn() {
    return Boolean(db.getSetting("hub.attach", false));
  }

  function cwdDefault() {
    return db.getSetting("cwd", "") || require("node:os").homedir();
  }

  // stdio entry for the JAgents MCP server, in ACP's {name, command, args, env[]} shape.
  function mcpEntry(paneId) {
    const node = nodePath();
    const env = [
      { name: "JAGENTS_PANE_ID", value: paneId },
      { name: "JAGENTS_HUB_FILE", value: hubFiles.hub },
    ];
    if (!node) env.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
    return { name: "jagents", command: node || process.execPath, args: [hubFiles.script], env };
  }

  function plugged() {
    try {
      return (pluginMcp && pluginMcp()) || { external: [], inApp: [], disabled: [] };
    } catch {
      return { external: [], inApp: [], disabled: [] };
    }
  }

  // Every MCP server an agent gets: jagents (when the hub is attached), servers
  // plugins run inside JAgents (through jagents-plugin-mcp.cjs), and outside
  // servers plugins list in plugin.json. ACP's {name, command, args, env[]} shape.
  function mcpEntries(paneId, withHub) {
    const out = withHub ? [mcpEntry(paneId)] : [];
    const p = plugged();
    const node = nodePath();
    for (const srv of p.inApp) {
      const env = [
        { name: "JAGENTS_SERVER", value: srv.name },
        { name: "JAGENTS_PANE_ID", value: paneId },
        { name: "JAGENTS_HUB_FILE", value: hubFiles.hub },
      ];
      if (!node) env.push({ name: "ELECTRON_RUN_AS_NODE", value: "1" });
      out.push({ name: srv.name, command: node || process.execPath, args: [hubFiles.pluginScript], env });
    }
    for (const srv of p.external) out.push({ name: srv.name, command: srv.command, args: srv.args, env: Object.entries(srv.env || {}).map(([name, value]) => ({ name, value: String(value) })) });
    return out;
  }

  // Tools plugins turned off. jagents and in-app servers drop them in the hub;
  // these lists cover outside servers and Claude Code's own tools.
  function disabledTools() {
    return plugged().disabled;
  }

  function claudeDisallowed() {
    return disabledTools().map(claudeToolName);
  }

  function systemNote(handle) {
    return (
      "You are " + handle + ", one of several coding agents running side by side in JAgents. " +
      "The jagents MCP server lets you list the other agents (list_agents), message one (send_message), read what one is doing (read_agent), " +
      "spawn subagents such as Claude Code, Devin or Cursor on a task (spawn_subagent, wait_for_agent), and hand your context to another agent (handoff_context)."
    );
  }

  // Per-launch MCP wiring: Claude Code takes --mcp-config, Codex takes -c
  // overrides. Nothing global is written; the global installs live in mcp-install.cjs.
  function launchArgs(provider, pane, attach, initialPrompt) {
    // Codex's startup update menu would swallow the first relayed message.
    const args = provider === "codex" ? ["-c", "check_for_update_on_startup=false"] : [];
    // Handoff files live in JAgents's data folder; without this Claude Code asks
    // before reading outside its working folder.
    if (provider === "claude") {
      const handoffs = path.join(dataRoot, "handoffs");
      fs.mkdirSync(handoffs, { recursive: true });
      args.push("--add-dir", handoffs);
    }
    const entries = pane.mcp === false ? [] : mcpEntries(pane.id, attach);
    if (entries.length && provider === "claude") {
      const dir = path.join(dataRoot, "mcp");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, pane.id + ".json");
      const servers = {};
      for (const e of entries) {
        const env = {};
        for (const item of e.env) env[item.name] = item.value;
        servers[e.name] = { command: e.command, args: e.args, env };
      }
      fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2));
      args.push("--mcp-config", file);
      if (attach) args.push("--append-system-prompt", systemNote(pane.handle));
    }
    // The Devin CLI reads MCP servers only from its config files. The entry
    // leaves out the pane id; the hub finds the caller from its parent process.
    if (entries.length && provider === "devin-cli") {
      const { writeDevinMcpConfig } = require("./acp-host.cjs");
      writeDevinMcpConfig(pane.cwd, entries.map((e) => Object.assign({}, e, { env: e.env.filter((item) => item.name !== "JAGENTS_PANE_ID") })));
    }
    if (provider === "claude" && claudeDisallowed().length) args.push("--disallowedTools", claudeDisallowed().join(","));
    if (entries.length && provider === "codex") {
      const off = disabledTools();
      for (const e of entries) {
        const key = "mcp_servers." + e.name;
        const envPairs = e.env.map((item) => item.name + "=" + tomlLiteral(item.value)).join(", ");
        args.push("-c", key + ".command=" + tomlLiteral(e.command));
        args.push("-c", key + ".args=[" + e.args.map(tomlLiteral).join(", ") + "]");
        args.push("-c", key + ".env={" + envPairs + "}");
        const blocked = off.filter((t) => t.startsWith(e.name + ".")).map((t) => t.slice(e.name.length + 1));
        if (blocked.length) args.push("-c", key + ".disabled_tools=[" + blocked.map(tomlLiteral).join(", ") + "]");
      }
    }
    // --add-dir and --mcp-config take several values; "--" keeps the prompt out of them.
    if (initialPrompt) args.push(...(provider === "claude" ? ["--", initialPrompt] : [initialPrompt]));
    return args;
  }

  function launchTerminal(pane, size, initialPrompt) {
    const attach = pane.mcp && hubOn();
    const spec = terminalSpawnSpec(pane.provider, launchArgs(pane.provider, pane, attach, initialPrompt));
    const env = Object.assign({}, spec.env, { JAGENTS_PANE_ID: pane.id, JAGENTS_HUB_FILE: hubFiles.hub, JAGENTS_HANDLE: pane.handle });
    if (!fs.existsSync(pane.cwd)) throw new Error("Folder not found: " + pane.cwd);
    // Terminals JAgents wires per launch; others only have it through a global install.
    pane.attached = Boolean(attach) && ["claude", "codex", "devin-cli"].includes(pane.provider);
    return ptyHost.create({ id: pane.id, command: spec.command, args: spec.args, cwd: pane.cwd, env, cols: size && size.cols, rows: size && size.rows });
  }

  function addTerminal(input) {
    const src = input || {};
    const agent = terminalAgent(src.provider);
    if (!agent) throw new Error("Unknown terminal agent: " + src.provider);
    const pane = {
      id: "term-" + randomUUID().slice(0, 8),
      kind: "terminal",
      provider: agent.id,
      name: agent.name,
      handle: nextHandle(agent.id),
      title: src.title || agent.name,
      cwd: src.cwd || cwdDefault(),
      parentId: src.parentId || "",
      mcp: src.mcp !== false,
      createdAt: Date.now(),
    };
    panes.push(pane);
    try {
      launchTerminal(pane, src.size, src.initialPrompt);
    } catch (error) {
      panes = panes.filter((p) => p.id !== pane.id);
      save();
      throw error;
    }
    save();
    return pane;
  }

  // The renderer mounts a terminal pane and reports its size; a pane restored
  // from the last run has no process yet, so this starts one.
  function ensureTerminal(id, size) {
    const pane = panes.find((p) => p.id === id && p.kind === "terminal");
    if (!pane) throw new Error("No terminal pane " + id + ".");
    if (!ptyHost.has(id)) launchTerminal(pane, size);
    else if (size) ptyHost.resize(id, size.cols, size.rows);
    return ptyHost.snapshot(id);
  }

  // Terminal panes from the last run start with the app, so agents are reachable
  // through the hub before (or without) the window drawing them.
  function launchRestored() {
    for (const pane of panes) {
      if (pane.kind !== "terminal" || ptyHost.has(pane.id)) continue;
      try {
        launchTerminal(pane, { cols: 120, rows: 32 });
      } catch (error) {
        console.error("Could not restart " + pane.handle + ": " + error.message);
      }
    }
  }

  function restartTerminal(id, size) {
    const pane = panes.find((p) => p.id === id && p.kind === "terminal");
    if (!pane) throw new Error("No terminal pane " + id + ".");
    ptyHost.kill(id);
    launchTerminal(pane, size);
    save();
    return ptyHost.snapshot(id);
  }

  function newChat(input) {
    const src = input || {};
    const agent = acpAgent(src.harnessId);
    if (!agent) throw new Error("Unknown ACP agent: " + src.harnessId);
    return acpHost.createChat({ harnessId: agent.id, cwd: src.cwd || cwdDefault(), parentId: src.parentId || "", handle: nextHandle(agent.id), title: src.title, transcript: src.transcript });
  }

  // A chat pane shows a chat thread. Opening an existing thread in Code mode
  // reuses its chat; otherwise a new chat is created for the agent.
  function addChatPane(input) {
    const src = input || {};
    let chatId = src.chatId;
    if (!chatId) chatId = newChat(src).chatId;
    const existing = panes.find((p) => p.kind === "chat" && p.chatId === chatId);
    if (existing) return existing;
    const chat = db.getChat(chatId);
    if (!chat) throw new Error("That chat no longer exists.");
    const agent = acpAgent(chat.harnessId);
    const pane = { id: "chat-" + chatId.slice(0, 8), kind: "chat", chatId, provider: chat.harnessId, name: agent ? agent.name : chat.harnessId, handle: chat.handle, title: chat.title, cwd: chat.cwd, parentId: chat.parentId, createdAt: Date.now() };
    panes.push(pane);
    save();
    return pane;
  }

  // A pane whose kind a plugin registered (jagents.panes.register). Its state is
  // the plugin's to keep; JAgents only stores it with the layout.
  function addPluginPane(input) {
    const src = input || {};
    const kind = String(src.kind || "");
    if (!/^[a-z0-9][a-z0-9-]{0,39}:[a-z0-9][a-z0-9-]{0,39}$/.test(kind)) throw new Error("Plugin pane kinds look like plugin-id:kind.");
    const pane = { id: "plug-" + randomUUID().slice(0, 8), kind: "plugin", pluginKind: kind, handle: kind.split(":")[1], name: String(src.title || kind), title: String(src.title || kind), state: src.state && typeof src.state === "object" ? src.state : {}, createdAt: Date.now() };
    panes.push(pane);
    save();
    return pane;
  }

  function updatePluginPane(id, patch) {
    const pane = panes.find((p) => p.id === id && p.kind === "plugin");
    if (!pane) return null;
    const src = patch || {};
    if (src.state && typeof src.state === "object") pane.state = src.state;
    if (src.title != null) pane.title = String(src.title).slice(0, 80);
    // State changes are frequent (a browser's URL); only a title change redraws.
    if (src.title != null) save();
    else db.setSetting("panes", panes);
    return pane;
  }

  function removePane(id, options) {
    const pane = panes.find((p) => p.id === id);
    if (!pane) return false;
    panes = panes.filter((p) => p.id !== id);
    if (pane.kind === "terminal") ptyHost.kill(id);
    else if (options && options.stopChat) acpHost.stopChat(pane.chatId);
    save();
    return true;
  }

  function reorder(ids) {
    const byId = new Map(panes.map((p) => [p.id, p]));
    const next = ids.map((id) => byId.get(id)).filter(Boolean);
    for (const p of panes) if (!next.includes(p)) next.push(p);
    panes = next;
    save();
  }

  function list() {
    return panes.map((p) => {
      if (p.kind === "chat") {
        const chat = db.getChat(p.chatId);
        return Object.assign({}, p, { title: chat ? chat.title : p.title, provider: chat ? chat.harnessId : p.provider, handle: chat ? chat.handle : p.handle });
      }
      return Object.assign({}, p, { status: ptyHost.status(p.id) });
    });
  }

  // Everything the hub treats as an agent: terminal panes, plus chats that are
  // on screen or have a live session (subagents keep running when closed).
  function agents() {
    const out = [];
    for (const p of panes) {
      if (p.kind !== "terminal") continue;
      out.push({ id: p.id, handle: p.handle, kind: "terminal", provider: p.provider, name: p.name, title: p.title, cwd: p.cwd, parentId: p.parentId, status: ptyHost.status(p.id), pid: ptyHost.pid(p.id), mcp: Boolean(p.attached) });
    }
    const chatIds = new Set(panes.filter((p) => p.kind === "chat").map((p) => p.chatId).concat(acpHost.liveIds()));
    for (const chatId of chatIds) {
      const snap = acpHost.snapshot(chatId);
      if (!snap) continue;
      const agent = acpAgent(snap.harnessId);
      out.push({ id: chatId, handle: snap.handle, kind: "chat", provider: snap.harnessId, name: agent ? agent.name : snap.harnessId, title: snap.title, cwd: snap.cwd, parentId: snap.parentId, status: snap.status, pid: acpHost.childPid(chatId), mcp: true, queued: snap.queued });
    }
    return out;
  }

  function findAgent(ref) {
    const key = String(ref || "").trim().replace(/^@/, "").toLowerCase();
    if (!key) return null;
    const all = agents();
    return all.find((a) => a.handle.toLowerCase() === key) || all.find((a) => a.id.toLowerCase() === key) || null;
  }

  function paneForChat(chatId) {
    return panes.find((p) => p.kind === "chat" && p.chatId === chatId) || null;
  }

  return { list, agents, findAgent, addTerminal, ensureTerminal, restartTerminal, launchRestored, addChatPane, addPluginPane, updatePluginPane, newChat, removePane, reorder, paneForChat, cwdDefault, hubOn, mcpEntry, mcpEntries, claudeDisallowed, systemNote };
}

module.exports = { createWorkspace };
