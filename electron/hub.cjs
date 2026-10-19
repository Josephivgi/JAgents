"use strict";

// The Relay hub: a loopback HTTP server inside the app that the relay MCP
// server (mcp/relay-mcp.cjs) forwards tool calls to. It knows every running
// agent (terminal panes, chat panes, subagents), so an agent can list the
// others, message them, read them, spawn ACP subagents, and hand off context.
// Auth is a random bearer token in ~/.relay-ade/hub.json (user-only file).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { execFile } = require("node:child_process");
const { listAcpAgents, listTerminalAgents, acpAgent, terminalAgent } = require("../lib/agents");
const { readChatRows } = require("../lib/acp-handoff");
const { buildHandoff, writeHandoffFile, handoffInstruction } = require("../lib/handoff");

const HOME_DIR = process.env.RELAY_HOME ? path.resolve(process.env.RELAY_HOME) : path.join(os.homedir(), ".relay-ade");
const WAIT_DEFAULT_S = 50;
const WAIT_MAX_S = 900;

const TOOLS = [
  { name: "whoami", description: "Your own Relay identity: handle, kind (terminal or chat), provider, and working folder.", inputSchema: { type: "object", properties: {} } },
  {
    name: "list_agents",
    description: "List every coding agent running in Relay right now: terminal agents (Claude Code, Codex, shells) and chat/ACP agents (Devin, Cursor, subagents). Each has a handle you can pass to the other tools.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description: "Send a message to another running agent. Terminal agents get it typed into their prompt; chat agents get it as their next turn (queued if they are busy). Use read_agent or wait_for_agent to see the reply.",
    inputSchema: { type: "object", properties: { to: { type: "string", description: "Handle of the agent, e.g. codex-1" }, message: { type: "string" } }, required: ["to", "message"] },
  },
  {
    name: "read_agent",
    description: "Read what another agent has been doing. Terminal agents: the last lines of their screen. Chat agents: their transcript rows (messages, tool calls with input and output). Page back with before, read one row in full with row, or search with query.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Handle of the agent" },
        lines: { type: "number", description: "Terminal agents: how many lines (default 120, max 2000)" },
        before: { type: "number", description: "Chat agents: return rows before this row number" },
        row: { type: "number", description: "Chat agents: one row in full" },
        query: { type: "string", description: "Chat agents: only rows containing this text" },
        limit: { type: "number", description: "Chat agents: rows per page (default 40)" },
      },
      required: ["agent"],
    },
  },
  {
    name: "list_providers",
    description: "List the ACP agents that spawn_subagent can start (Devin, Cursor, Claude Code ACP, Codex ACP, Gemini, ...) and whether each is installed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "spawn_subagent",
    description: "Start a subagent (Claude Code natively, or an ACP agent such as devin or cursor) on a task. It appears as a chat pane in Relay, can use the relay tools itself, and reports to you. With wait (default true) this returns its reply when it finishes or when timeout_seconds pass; otherwise call wait_for_agent later.",
    inputSchema: {
      type: "object",
      properties: {
        provider: { type: "string", description: "Agent id from list_providers, e.g. claude-code, devin, cursor, codex, gemini" },
        task: { type: "string", description: "What the subagent should do. Be specific; it does not see your conversation." },
        cwd: { type: "string", description: "Working folder (defaults to yours)" },
        wait: { type: "boolean", description: "Wait for the reply (default true)" },
        timeout_seconds: { type: "number", description: "How long to wait (default 50, max 900)" },
      },
      required: ["provider", "task"],
    },
  },
  {
    name: "wait_for_agent",
    description: "Wait until an agent finishes its current turn (chat agents) or goes quiet (terminal agents), then return its latest reply or screen.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, timeout_seconds: { type: "number", description: "Default 50, max 900" } }, required: ["agent"] },
  },
  {
    name: "stop_agent",
    description: "Stop a chat agent's current turn. Pass close to also end its session and remove its pane. Only works on chat/ACP agents.",
    inputSchema: { type: "object", properties: { agent: { type: "string" }, close: { type: "boolean" } }, required: ["agent"] },
  },
  {
    name: "handoff_context",
    description: "Hand your context (recent conversation and work) to another agent so it can continue. Pass to for a running agent, or provider for a new one: claude or codex (new terminal) or an ACP id like devin (new chat). note says what the next agent should do.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string", description: "Handle of a running agent" }, provider: { type: "string", description: "Start a new agent instead: claude, codex, devin, cursor, ..." }, note: { type: "string" } },
    },
  },
  // Plugins: agents change the Relay app itself (plugins.cjs).
  {
    name: "plugin_docs",
    description: "How Relay plugins work. Plugins change the Relay app: its UI (top bar buttons, sidebar sections, new pane types, CSS), the MCP servers every agent gets (outside servers, or new ones that run inside Relay), and which tools agents may use. Read this before write_plugin.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_plugins",
    description: "List the Relay app's plugins: id, name, on/off, who changed each last, load errors, the MCP servers each gives agents, and the tools each turns off.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_plugin",
    description: "Read every file of a Relay plugin.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "write_plugin",
    description: "Create or change a Relay plugin; the app reloads it live and the user sees it in the Plugins panel. files maps paths in the plugin folder (renderer.js, style.css, main.cjs, plugin.json, others) to their full new content, or null to delete a file; files you leave out are kept. Returns the plugin's state including load errors, so fix and write again if errors.renderer, errors.main or errors.mcp is set. Call plugin_docs first.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Lowercase id, e.g. pomodoro-timer" },
        name: { type: "string", description: "Display name" },
        description: { type: "string", description: "One sentence for the Plugins panel" },
        files: { type: "object", description: "Path -> full file content (string), or null to delete", additionalProperties: { type: ["string", "null"] } },
      },
      required: ["id", "files"],
    },
  },
  {
    name: "set_plugin_enabled",
    description: "Turn a Relay plugin on or off.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, enabled: { type: "boolean" } }, required: ["id", "enabled"] },
  },
  {
    name: "undo_plugin",
    description: "Put a Relay plugin back to the version before its last change.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "delete_plugin",
    description: "Remove a Relay plugin. Its folder moves to the plugins trash, so it can be recovered by hand.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

function clampWait(seconds) {
  const s = Number(seconds);
  return Math.min(WAIT_MAX_S, Math.max(1, Number.isFinite(s) && s > 0 ? s : WAIT_DEFAULT_S)) * 1000;
}

// Windows has no ppid walk in Node: one CIM query gives the parent map.
function processTable() {
  return new Promise((resolve) => {
    if (process.platform !== "win32") {
      execFile("ps", ["-eo", "pid=,ppid="], (err, out) => {
        const map = new Map();
        if (!err) for (const line of out.split("\n")) {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          if (pid) map.set(pid, ppid);
        }
        resolve(map);
      });
      return;
    }
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024, timeout: 15000 },
      (err, out) => {
        const map = new Map();
        if (!err) for (const line of String(out).split(/\r?\n/)) {
          const [pid, ppid] = line.trim().split(/\s+/).map(Number);
          if (pid) map.set(pid, ppid);
        }
        resolve(map);
      },
    );
  });
}

function createHub({ workspace, ptyHost, acpHost, plugins, dataRoot, emit, notify }) {
  const token = randomBytes(24).toString("hex");
  const files = { dir: HOME_DIR, hub: path.join(HOME_DIR, "hub.json"), script: path.join(HOME_DIR, "relay-mcp.cjs"), pluginScript: path.join(HOME_DIR, "relay-plugin-mcp.cjs"), tools: path.join(HOME_DIR, "tools.json") };
  const callerCache = new Map();
  const log = [];
  let server = null;

  function record(entry) {
    log.push(Object.assign({ at: Date.now() }, entry));
    if (log.length > 300) log.splice(0, log.length - 300);
    emit("hub-activity", log.slice(-60));
  }

  // Plugins can turn relay tools off ("relay.spawn_subagent" in disableTools).
  function disabledRelay() {
    if (!plugins) return new Set();
    return new Set(plugins.agentMcp().disabled.filter((t) => t.startsWith("relay.")).map((t) => t.slice(6)));
  }

  function allTools() {
    const off = disabledRelay();
    return TOOLS.filter((t) => !off.has(t.name));
  }

  function writeToolsFile() {
    try {
      fs.writeFileSync(files.tools, JSON.stringify({ tools: allTools() }, null, 2));
    } catch {
      /* the live /tools route still answers */
    }
  }

  function writeFiles(port) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", "mcp", "relay-mcp.cjs"), files.script);
    fs.copyFileSync(path.join(__dirname, "..", "mcp", "relay-plugin-mcp.cjs"), files.pluginScript);
    writeToolsFile();
    fs.writeFileSync(files.hub, JSON.stringify({ port, token, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  }

  async function resolveCaller(c) {
    const src = c || {};
    if (src.paneId) {
      const hit = workspace.findAgent(src.paneId);
      if (hit) return hit;
    }
    const start = Number(src.ppid) || 0;
    if (!start) return null;
    if (callerCache.has(start)) {
      const cached = workspace.findAgent(callerCache.get(start));
      if (cached) return cached;
    }
    const agents = workspace.agents().filter((a) => a.pid);
    const byPid = new Map(agents.map((a) => [a.pid, a]));
    const table = await processTable();
    let pid = start;
    for (let depth = 0; pid && depth < 16; depth++) {
      if (byPid.has(pid)) {
        callerCache.set(start, byPid.get(pid).id);
        return byPid.get(pid);
      }
      pid = table.get(pid);
    }
    return null;
  }

  function needAgent(ref) {
    const agent = workspace.findAgent(ref);
    if (!agent) throw new Error("No agent named " + ref + ". Call list_agents to see who is running.");
    return agent;
  }

  function view(agent, me) {
    const parent = agent.parentId ? workspace.findAgent(agent.parentId) : null;
    return {
      handle: agent.handle,
      kind: agent.kind,
      provider: agent.provider,
      name: agent.name,
      title: agent.title,
      status: agent.status,
      cwd: agent.cwd,
      parent: parent ? parent.handle : agent.parentId ? "(closed)" : undefined,
      queued: agent.queued || undefined,
      you: me && me.id === agent.id ? true : undefined,
      relay_tools: agent.mcp,
    };
  }

  function readAgent(agent, args) {
    if (agent.kind === "terminal") {
      const lines = Math.min(2000, Math.max(1, Number(args.lines) || 120));
      return { handle: agent.handle, kind: "terminal", status: agent.status, screen: ptyHost.text(agent.id, lines) };
    }
    const snap = acpHost.snapshot(agent.id);
    const out = readChatRows({ id: agent.id, title: snap.title, harnessId: snap.harnessId, transcript: snap.transcript }, args);
    return Object.assign({ handle: agent.handle, kind: "chat", status: snap.status }, out);
  }

  async function sendMessage(from, to, message) {
    const text = String(message || "").trim();
    if (!text) throw new Error("message is empty.");
    const sender = from ? from.handle : "someone outside Relay";
    if (to.kind === "terminal") {
      await ptyHost.sendInput(to.id, "[Relay message from " + sender + "] " + text.replace(/\s*\n\s*/g, " "));
      return { delivered: true, to: to.handle, note: "Typed into " + to.handle + "'s prompt. Use read_agent or wait_for_agent to see the reply." };
    }
    const out = acpHost.deliver(to.id, text, sender);
    return Object.assign({ to: to.handle }, out, { note: out.queued ? to.handle + " is busy; your message is queued (" + out.queued + " waiting)." : "Sent. Use wait_for_agent to get the reply." });
  }

  async function waitFor(agent, timeoutMs) {
    if (agent.kind === "terminal") {
      const why = await ptyHost.waitIdle(agent.id, 4000, timeoutMs);
      return { handle: agent.handle, status: why === "timeout" ? "busy" : why, screen: ptyHost.text(agent.id, 80) };
    }
    const why = await acpHost.waitTurn(agent.id, timeoutMs);
    const snap = acpHost.snapshot(agent.id);
    return {
      handle: agent.handle,
      status: why === "timeout" ? "still working" : snap.status,
      reply: acpHost.lastReply(agent.id) || (why === "timeout" ? "(no reply yet)" : "(no text reply)"),
      error: snap.error || undefined,
      hint: why === "timeout" ? "Call wait_for_agent again with agent " + agent.handle + " to keep waiting." : undefined,
    };
  }

  async function spawnSubagent(me, args) {
    const provider = String(args.provider || "").trim().toLowerCase();
    const agentDef = acpAgent(provider);
    if (!agentDef) throw new Error("Unknown provider " + provider + ". Call list_providers.");
    const avail = listAcpAgents().find((a) => a.id === agentDef.id);
    if (!avail || !avail.available) throw new Error(agentDef.name + " is not installed. " + agentDef.install);
    const task = String(args.task || "").trim();
    if (!task) throw new Error("task is empty.");
    const cwd = String(args.cwd || (me && me.cwd) || workspace.cwdDefault());
    const pane = workspace.addChatPane({ harnessId: provider, cwd, parentId: me ? me.id : "", title: task.replace(/\s+/g, " ").slice(0, 60) });
    const sub = workspace.findAgent(pane.chatId);
    record({ type: "spawn", from: me ? me.handle : "external", to: sub.handle, text: task });
    if (notify) notify("Spawned " + sub.handle + (me ? " for " + me.handle : ""));
    acpHost.prompt(pane.chatId, task, { from: me ? me.handle : "" }).then(
      () => onSubagentDone(me, sub, args.wait === false),
      () => onSubagentDone(me, sub, args.wait === false),
    );
    if (args.wait === false) return { handle: sub.handle, status: "started", note: "Call wait_for_agent with agent " + sub.handle + " for its reply." + (me && me.kind === "terminal" ? " Relay will also tell you when it finishes." : "") };
    await new Promise((r) => setTimeout(r, 50));
    const res = await waitFor(sub, clampWait(args.timeout_seconds));
    return Object.assign({ spawned: sub.handle }, res);
  }

  // A detached subagent finished: tell its terminal parent so it does not need
  // to poll. Chat parents already get the reply from wait_for_agent.
  function onSubagentDone(parent, sub, detached) {
    if (!detached || !parent || parent.kind !== "terminal" || !ptyHost.has(parent.id)) return;
    const reply = acpHost.lastReply(sub.id).replace(/\s+/g, " ").slice(0, 400);
    ptyHost.sendInput(parent.id, "[Relay] Subagent " + sub.handle + " finished: " + (reply || "(no text reply)") + (reply.length >= 400 ? " ... (read_agent " + sub.handle + " for the rest)" : "")).catch(() => {});
  }

  // Context handoff across agents. source is an agent; target is a running
  // agent (toRef) or a new one (provider). Returns what happened.
  async function handoff(source, opts) {
    const o = opts || {};
    const note = String(o.note || "").trim();
    const src = Object.assign({}, source);
    if (source.kind === "terminal") src.text = ptyHost.text(source.id, 2000);
    else src.rows = acpHost.snapshot(source.id).transcript;
    let target = o.to ? needAgent(o.to) : null;
    if (target && target.id === source.id) throw new Error("Pick another agent to hand off to.");
    const provider = String(o.provider || "").trim().toLowerCase();
    if (!target && !provider) throw new Error("Pass to (a running agent) or provider (a new one).");
    const markdown = buildHandoff(src, { note, toHandle: target ? target.handle : "a new " + provider + " agent" });
    const file = writeHandoffFile(dataRoot, markdown);
    const marker = { text: "Context handed off from " + source.handle + " (" + source.name + ").", from: source.handle, file };
    let result;
    if (target && target.kind === "terminal") {
      await ptyHost.sendInput(target.id, handoffInstruction(source, file, note));
      result = { to: target.handle, file };
    } else if (target) {
      acpHost.receiveHandoff(target.id, Object.assign({ instruction: markdown }, marker));
      if (note && !acpHost.isBusy(target.id)) acpHost.deliver(target.id, note, "");
      result = { to: target.handle, file, note: note ? "Sent with your note." : "It will read the handoff with the next message." };
    } else if (terminalAgent(provider) && provider !== "shell") {
      const pane = workspace.addTerminal({ provider, cwd: source.cwd, parentId: "", initialPrompt: handoffInstruction(source, file, note), size: o.size });
      result = { to: pane.handle, file, started: true };
    } else if (acpAgent(provider)) {
      const pane = workspace.addChatPane({ harnessId: provider, cwd: source.cwd, title: "Handoff from " + source.handle });
      acpHost.receiveHandoff(pane.chatId, Object.assign({ instruction: markdown }, marker));
      const sub = workspace.findAgent(pane.chatId);
      if (note) acpHost.deliver(pane.chatId, note, "");
      result = { to: sub.handle, file, started: true };
    } else {
      throw new Error("Unknown provider " + provider + ".");
    }
    record({ type: "handoff", from: source.handle, to: result.to, text: note });
    return result;
  }

  async function call(name, args, me) {
    const a = args || {};
    if (disabledRelay().has(name)) throw new Error(name + " is turned off by a Relay plugin.");
    switch (name) {
      case "whoami":
        if (!me) return { handle: null, note: "This agent was not started by Relay, so it has no handle. It can still list and message Relay agents." };
        return view(me, me);
      case "list_agents":
        return { you: me ? me.handle : null, agents: workspace.agents().map((x) => view(x, me)) };
      case "list_providers":
        return { subagents: listAcpAgents().map((x) => ({ provider: x.id, name: x.name, installed: x.available, install: x.available ? undefined : x.install })), terminals: listTerminalAgents().filter((t) => t.id !== "shell").map((t) => ({ provider: t.id, name: t.name, installed: t.available })) };
      case "send_message": {
        const to = needAgent(a.to);
        if (me && to.id === me.id) throw new Error("That is you.");
        const out = await sendMessage(me, to, a.message);
        record({ type: "message", from: me ? me.handle : "external", to: to.handle, text: String(a.message || "") });
        return out;
      }
      case "read_agent":
        return readAgent(needAgent(a.agent), a);
      case "spawn_subagent":
        return spawnSubagent(me, a);
      case "wait_for_agent":
        return waitFor(needAgent(a.agent), clampWait(a.timeout_seconds));
      case "stop_agent": {
        const target = needAgent(a.agent);
        if (target.kind !== "chat") throw new Error("stop_agent only works on chat agents. Use send_message to ask a terminal agent to stop.");
        acpHost.cancel(target.id);
        if (a.close) {
          const pane = workspace.paneForChat(target.id);
          if (pane) workspace.removePane(pane.id);
          acpHost.stopChat(target.id);
        }
        record({ type: "stop", from: me ? me.handle : "external", to: target.handle, text: a.close ? "closed" : "stopped" });
        return { stopped: target.handle, closed: Boolean(a.close) };
      }
      case "handoff_context":
        if (!me) throw new Error("Only agents started in Relay can hand off their context.");
        return handoff(me, { to: a.to, provider: a.provider, note: a.note });
      case "plugin_docs":
        return needPlugins().docs;
      case "list_plugins":
        return needPlugins().list();
      case "read_plugin":
        return needPlugins().read(a.id);
      case "write_plugin": {
        const out = await needPlugins().write(a.id, { name: a.name, description: a.description, files: a.files }, author(me));
        pluginChanged(me, out.name || a.id, out.created ? "created" : "changed");
        return out;
      }
      case "set_plugin_enabled": {
        const out = await needPlugins().setEnabled(a.id, a.enabled, author(me));
        pluginChanged(me, (out && out.name) || a.id, a.enabled ? "turned on" : "turned off");
        return out;
      }
      case "undo_plugin": {
        const out = await needPlugins().undo(a.id, author(me));
        pluginChanged(me, (out && out.name) || a.id, "undid the last change to");
        return out;
      }
      case "delete_plugin": {
        const out = await needPlugins().remove(a.id, author(me));
        pluginChanged(me, a.id, "removed");
        return out;
      }
      default:
        throw new Error("Unknown tool " + name);
    }
  }

  function needPlugins() {
    if (!plugins) throw new Error("Plugins are not available in this Relay.");
    return plugins;
  }

  function author(me) {
    return me ? me.handle : "an agent outside Relay";
  }

  function pluginChanged(me, name, verb) {
    record({ type: "plugin", from: author(me), to: name, text: verb });
    if (notify) notify(author(me) + " " + verb + " the " + name + " plugin. Open Plugins to review or undo.");
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let data = "";
      req.setEncoding("utf8");
      req.on("data", (c) => {
        data += c;
        if (data.length > 4 * 1024 * 1024) req.destroy(new Error("Body too large"));
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  function start() {
    return new Promise((resolve, reject) => {
      server = http.createServer(async (req, res) => {
        const reply = (status, obj) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(obj));
        };
        if (req.headers.authorization !== "Bearer " + token) return reply(401, { error: "Bad token" });
        try {
          if (req.method === "GET" && req.url === "/tools") return reply(200, { tools: allTools() });
          // MCP servers that plugins run inside Relay (mcp/relay-plugin-mcp.cjs).
          const srv = /^\/servers\/([^/]+)\/(tools|call)$/.exec(req.url);
          if (srv && plugins) {
            const name = decodeURIComponent(srv[1]);
            if (req.method === "GET" && srv[2] === "tools") return reply(200, plugins.appServerTools(name));
            if (req.method === "POST" && srv[2] === "call") {
              const body = JSON.parse((await readBody(req)) || "{}");
              const me = await resolveCaller(body.caller);
              const result = await plugins.callAppServer(name, String(body.name || ""), body.args, me ? view(me, me) : null);
              record({ type: "tool", from: me ? me.handle : "external", to: name, text: String(body.name || "") });
              return reply(200, { result: result === undefined ? null : result });
            }
          }
          if (req.method === "POST" && req.url === "/call") {
            const body = JSON.parse((await readBody(req)) || "{}");
            const me = await resolveCaller(body.caller);
            const result = await call(String(body.name || ""), body.args, me);
            return reply(200, { result });
          }
          reply(404, { error: "Not found" });
        } catch (error) {
          reply(400, { error: String(error.message || error) });
        }
      });
      server.requestTimeout = 0;
      server.headersTimeout = 60000;
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        writeFiles(port);
        resolve({ port });
      });
    });
  }

  function stop() {
    if (server) server.close();
    try {
      const cur = JSON.parse(fs.readFileSync(files.hub, "utf8"));
      if (cur.pid === process.pid) fs.unlinkSync(files.hub);
    } catch {
      /* already gone */
    }
  }

  return { start, stop, files, handoff, call, activity: () => log.slice(-60), tools: allTools, toolsChanged: writeToolsFile };
}

module.exports = { createHub, HOME_DIR };
