"use strict";

// The workspace: every pane (terminal or chat), its handle (claude-1, devin-2),
// the Code-mode layout, and how terminal agents are launched with the JAgents
// MCP server attached. Panes persist in jagents.db; terminals keep running in
// the pty daemon through an app restart (and relaunch fresh after a real quit),
// chats resume through session/load when the agent supports it.

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

function createWorkspace({ db, dataRoot, ptyHost, acpHost, emit, hubFiles, pluginMcp, jworkspaceMcp }) {
  let panes = (db.getSetting("panes", []) || []).filter((p) => p && p.id && p.kind);
  const counters = db.getSetting("handle-counters", {}) || {};
  const DEFAULT_WS = "default";
  // Panes from before workspaces move into their project's Default workspace.
  if (panes.some((p) => !p.workspace)) {
    for (const p of panes) if (!p.workspace) p.workspace = DEFAULT_WS;
    db.setSetting("panes", panes);
  }

  function save() {
    db.setSetting("panes", panes);
    emit("panes-changed", list());
    // A pane in a new folder adds that folder as a project.
    const known = (db.getSetting("projects", null) || []).length;
    if (projectList().length !== known) emit("projects-changed", projects());
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

  // ---- Projects: folders agents work in -----------------------------------
  //
  // A project is a folder. Every pane belongs to the project whose folder is its
  // working folder; the active project's folder is where new agents start (the
  // "cwd" setting). Folders that panes use are added on their own.

  const normPath = (p) => path.resolve(String(p || "")).replace(/[\/]+$/, "").toLowerCase();

  function projectList() {
    const saved = (db.getSetting("projects", null) || []).filter((p) => p && p.path);
    const seen = new Set(saved.map((p) => normPath(p.path)));
    let added = false;
    for (const dir of [cwdDefault()].concat(panes.map((p) => p.cwd).filter(Boolean))) {
      if (seen.has(normPath(dir))) continue;
      seen.add(normPath(dir));
      saved.push({ path: dir, name: path.basename(dir) || dir });
      added = true;
    }
    if (added || !db.getSetting("projects", null)) db.setSetting("projects", saved);
    return saved;
  }

  function projects() {
    const active = normPath(cwdDefault());
    const all = wsState();
    return projectList().map((p) => {
      const ws = wsFor(p.path, all);
      return Object.assign({}, p, { active: normPath(p.path) === active, workspaces: ws.list, workspace: ws.active });
    });
  }

  function setActiveProject(dir) {
    if (!dir || !fs.existsSync(dir)) throw new Error("Folder not found: " + dir);
    db.setSetting("cwd", dir);
    projectList();
    emit("projects-changed", projects());
    return projects();
  }

  function addProject(dir) {
    if (!dir || !fs.existsSync(dir)) throw new Error("Folder not found: " + dir);
    const list = projectList();
    if (!list.some((p) => normPath(p.path) === normPath(dir))) {
      list.push({ path: dir, name: path.basename(dir) || dir });
      db.setSetting("projects", list);
    }
    return setActiveProject(dir);
  }

  // Removes a project from the list. Its agents must be closed first.
  function removeProject(dir) {
    const key = normPath(dir);
    if (panes.some((p) => p.cwd && normPath(p.cwd) === key)) throw new Error("Close this project's agents first.");
    const list = projectList().filter((p) => normPath(p.path) !== key);
    db.setSetting("projects", list);
    const all = wsState();
    if (all[key]) {
      delete all[key];
      db.setSetting("workspaces", all);
    }
    if (normPath(cwdDefault()) === key) db.setSetting("cwd", list.length ? list[0].path : require("node:os").homedir());
    projectList();
    emit("projects-changed", projects());
    return projects();
  }

  function renameProject(dir, name) {
    const list = projectList();
    const p = list.find((x) => normPath(x.path) === normPath(dir));
    if (!p) throw new Error("No project " + dir + ".");
    p.name = String(name || "").trim().slice(0, 60) || path.basename(p.path);
    db.setSetting("projects", list);
    emit("projects-changed", projects());
    return projects();
  }

  // ---- Workspaces: separate sets of agents inside one project --------------
  //
  // Every project has a Default workspace and any number more. Each pane
  // belongs to one ("workspace" on the pane; panes from before workspaces are
  // in Default), and the window shows the open project's open workspace. The
  // others' agents keep running out of sight.
  //   setting "workspaces": { [project key]: { list: [{ id, name }], active } }

  function wsState() {
    const all = db.getSetting("workspaces", null);
    return all && typeof all === "object" ? all : {};
  }

  function wsFor(dir, all) {
    const s = (all || wsState())[normPath(dir)] || {};
    const list = [{ id: DEFAULT_WS, name: "Default" }].concat((Array.isArray(s.list) ? s.list : []).filter((w) => w && w.id && w.id !== DEFAULT_WS));
    const active = list.some((w) => w.id === s.active) ? s.active : DEFAULT_WS;
    return { list, active };
  }

  function wsSave(dir, ws) {
    const all = wsState();
    all[normPath(dir)] = { list: ws.list.filter((w) => w.id !== DEFAULT_WS), active: ws.active };
    db.setSetting("workspaces", all);
  }

  // The workspace a new pane joins: its parent agent's, else the one open in
  // its project.
  function workspaceForNew(src, cwd) {
    const parent = src.parentId && panes.find((p) => p.id === src.parentId || p.chatId === src.parentId);
    if (parent) return parent.workspace || DEFAULT_WS;
    const ws = wsFor(cwd || cwdDefault());
    return ws.list.some((w) => w.id === src.workspace) ? src.workspace : ws.active;
  }

  function paneWorkspace(p) {
    return p.workspace || DEFAULT_WS;
  }

  function addWorkspace(dir, name) {
    if (!dir || !fs.existsSync(dir)) throw new Error("Folder not found: " + dir);
    const ws = wsFor(dir);
    let n = ws.list.length + 1;
    while (ws.list.some((w) => w.name.toLowerCase() === ("workspace " + n).toLowerCase())) n++;
    const w = { id: "ws-" + randomUUID().slice(0, 8), name: String(name || "").replace(/\s+/g, " ").trim().slice(0, 40) || "Workspace " + n };
    ws.list.push(w);
    ws.active = w.id;
    wsSave(dir, ws);
    db.setSetting("cwd", dir);
    projectList();
    emit("projects-changed", projects());
    return projects();
  }

  function setActiveWorkspace(dir, id) {
    if (!dir || !fs.existsSync(dir)) throw new Error("Folder not found: " + dir);
    const ws = wsFor(dir);
    if (!ws.list.some((w) => w.id === id)) throw new Error("That workspace no longer exists.");
    ws.active = id;
    wsSave(dir, ws);
    db.setSetting("cwd", dir);
    projectList();
    emit("projects-changed", projects());
    return projects();
  }

  function renameWorkspace(dir, id, name) {
    const ws = wsFor(dir);
    const w = ws.list.find((x) => x.id === id);
    if (!w || id === DEFAULT_WS) throw new Error("The Default workspace keeps its name.");
    w.name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 40) || w.name;
    wsSave(dir, ws);
    emit("projects-changed", projects());
    return projects();
  }

  // Removes a workspace. Its agents must be closed first, as with projects.
  function removeWorkspace(dir, id) {
    if (id === DEFAULT_WS) throw new Error("The Default workspace can't be removed.");
    const key = normPath(dir);
    if (panes.some((p) => p.cwd && normPath(p.cwd) === key && paneWorkspace(p) === id)) throw new Error("Close this workspace's agents first.");
    const ws = wsFor(dir);
    ws.list = ws.list.filter((w) => w.id !== id);
    if (ws.active === id) ws.active = DEFAULT_WS;
    wsSave(dir, ws);
    emit("projects-changed", projects());
    return projects();
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

  // Every MCP server an agent gets: jagents (when the hub is attached),
  // jworkspace (when JWorkspace is on this computer, electron/jworkspace-link.cjs),
  // servers plugins run inside JAgents (through jagents-plugin-mcp.cjs), and
  // outside servers plugins list in plugin.json. ACP's {name, command, args, env[]} shape.
  function mcpEntries(paneId, withHub) {
    const out = withHub ? [mcpEntry(paneId)] : [];
    let jw = null;
    try {
      jw = jworkspaceMcp ? jworkspaceMcp() : null;
    } catch {
      jw = null;
    }
    if (jw) out.push(jw);
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
    // One server per name: the first one listed wins.
    const seen = new Set();
    return out.filter((e) => !seen.has(e.name) && seen.add(e.name));
  }

  // Tools plugins turned off. jagents and in-app servers drop them in the hub;
  // these lists cover outside servers and Claude Code's own tools.
  function disabledTools() {
    return plugged().disabled;
  }

  function claudeDisallowed() {
    return disabledTools().map(claudeToolName);
  }

  // What agents are told about the JAgents tools, matching what plugins left
  // on. With the Subagents plugin, subagents start through its spawn tool.
  function toolsNote() {
    const p = plugged();
    const off = new Set(p.disabled);
    const subs = p.inApp.some((s) => s.name === "subagents");
    const spawn = subs
      ? " To start a subagent (Claude Code, Codex, Devin, Cursor, Gemini, ...), use the subagents MCP server's spawn tool, not a built-in subagent or task tool, so the user sees it in JAgents."
      : off.has("jagents.spawn_subagent")
        ? ""
        : " Spawn subagents such as Claude Code, Devin or Cursor on a task with spawn_subagent and wait_for_agent.";
    return (
      " The jagents MCP server lets you list the other agents (list_agents), message one (send_message), read what one is doing (read_agent), " +
      "and hand your context to another agent (handoff_context)." + spawn
    );
  }

  function systemNote(handle) {
    return "You are " + handle + ", one of several coding agents running side by side in JAgents." + toolsNote();
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
    // Settings > Terminal > Claude Code layout. Unset, Claude Code picks.
    const layout = (db.getSetting("terminal", null) || {}).claudeLayout;
    if (pane.provider === "claude" && (layout === "classic" || layout === "fullscreen")) env.CLAUDE_CODE_NO_FLICKER = layout === "fullscreen" ? "1" : "0";
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
      workspace: workspaceForNew(src, src.cwd || cwdDefault()),
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
    // No size: the view is in a hidden tab and has not been measured; the
    // process keeps its size until the tab is shown.
    if (!ptyHost.has(id)) launchTerminal(pane, size || pane.size);
    else if (size) resizeTerminal(id, size.cols, size.rows);
    return ptyHost.snapshot(id);
  }

  // The last size each terminal had, so the next app start launches it at
  // that size instead of a guess that the agent then redraws for.
  let sizeTimer = null;
  function resizeTerminal(id, cols, rows) {
    ptyHost.resize(id, cols, rows);
    const pane = panes.find((p) => p.id === id && p.kind === "terminal");
    if (!pane || !(cols > 0 && rows > 0)) return;
    pane.size = { cols: Math.floor(cols), rows: Math.floor(rows) };
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      sizeTimer = null;
      db.setSetting("panes", panes);
    }, 2000);
  }

  // A size save still waiting goes out now; the app is stopping. save false:
  // it is dropped, because another JAgents has the data now.
  function flush(save) {
    if (!sizeTimer) return;
    clearTimeout(sizeTimer);
    sizeTimer = null;
    if (save !== false) db.setSetting("panes", panes);
  }

  // Terminal panes from the last run start with the app, so agents are reachable
  // through the hub before (or without) the window drawing them.
  function launchRestored() {
    for (const pane of panes) {
      if (pane.kind !== "terminal" || ptyHost.has(pane.id)) continue;
      try {
        launchTerminal(pane, pane.size || { cols: 120, rows: 32 });
      } catch (error) {
        console.error("Could not restart " + pane.handle + ": " + error.message);
      }
    }
  }

  function restartTerminal(id, size) {
    const pane = panes.find((p) => p.id === id && p.kind === "terminal");
    if (!pane) throw new Error("No terminal pane " + id + ".");
    ptyHost.kill(id);
    launchTerminal(pane, size || pane.size);
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
    const pane = { id: "chat-" + chatId.slice(0, 8), kind: "chat", chatId, provider: chat.harnessId, name: agent ? agent.name : chat.harnessId, handle: chat.handle, title: chat.title, cwd: chat.cwd, parentId: chat.parentId, workspace: workspaceForNew({ parentId: chat.parentId, workspace: src.workspace }, chat.cwd), createdAt: Date.now() };
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
    const pane = { id: "plug-" + randomUUID().slice(0, 8), kind: "plugin", pluginKind: kind, handle: kind.split(":")[1], name: String(src.title || kind), title: String(src.title || kind), state: src.state && typeof src.state === "object" ? src.state : {}, workspace: workspaceForNew(src, cwdDefault()), createdAt: Date.now() };
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

  // A terminal or plugin tab's own name; an empty one goes back to the
  // agent's name. Chats take theirs from the conversation.
  function renamePane(id, title) {
    const pane = panes.find((p) => p.id === id && (p.kind === "terminal" || p.kind === "plugin"));
    if (!pane) throw new Error("This tab can't be renamed.");
    pane.title = String(title == null ? "" : title).replace(/\s+/g, " ").trim().slice(0, 60) || pane.name;
    save();
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

  return { list, agents, findAgent, addTerminal, ensureTerminal, resizeTerminal, restartTerminal, launchRestored, flush, addChatPane, addPluginPane, updatePluginPane, renamePane, addWorkspace, setActiveWorkspace, renameWorkspace, removeWorkspace, newChat, removePane, reorder, paneForChat, cwdDefault, projects, addProject, removeProject, renameProject, setActiveProject, hubOn, mcpEntry, mcpEntries, claudeDisallowed, systemNote, toolsNote };
}

module.exports = { createWorkspace };
