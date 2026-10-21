"use strict";

// Native Claude Code chats through the Claude Agent SDK, the way T3 Code runs
// Claude: one long-lived query() per thread fed by a streaming input queue,
// Claude Code's own system prompt preset, partial messages for live text, and
// resume by session id. It speaks the same small interface as AcpClient
// (start, initialize, newSession, loadSession, promptWithRecovery, cancel,
// setModel, stop) and turns SDK messages into ACP-shaped session/update
// params, so acp-host, threads, handoffs and the hub treat it like any chat.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawnHidden, killTree } = require("./win-command");
const { sdkContent } = require("./attachments");

const MODELS_TIMEOUT_MS = 45000;
const TOOL_OUTPUT_MAX = 4000;

let sdkPromise = null;
function loadSdk() {
  // The SDK is ESM-only; the main process is CommonJS.
  if (!sdkPromise) sdkPromise = import("@anthropic-ai/claude-agent-sdk");
  return sdkPromise;
}

// Streaming input for query(): user messages are pushed as the chat sends them.
class InputQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
  }
  push(item) {
    if (this.ended) throw new Error("Claude Code session is closed.");
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer));
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

// Claude Code keeps each session at <config>/projects/<folder slug>/<id>.jsonl;
// resume only works when that file is there.
function sessionFileExists(sessionId) {
  const root = path.join(claudeConfigDir(), "projects");
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return false;
  }
  return dirs.some((d) => fs.existsSync(path.join(root, d, sessionId + ".jsonl")));
}

function short(value, max) {
  const s = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function toolInfo(name, input, cwd) {
  const i = input || {};
  const rel = (p) => {
    const s = String(p || "");
    const r = cwd && s ? path.relative(cwd, s) : s;
    return r && !r.startsWith("..") && !path.isAbsolute(r) ? r : s;
  };
  switch (name) {
    case "Bash":
      return { kind: "execute", title: "Run " + short(i.command, 90) };
    case "Read":
      return { kind: "read", title: "Read " + rel(i.file_path) };
    case "Write":
      return { kind: "edit", title: "Write " + rel(i.file_path) };
    case "Edit":
    case "MultiEdit":
      return { kind: "edit", title: "Edit " + rel(i.file_path) };
    case "NotebookEdit":
      return { kind: "edit", title: "Edit " + rel(i.notebook_path) };
    case "Grep":
      return { kind: "search", title: "Search " + short(i.pattern, 60) };
    case "Glob":
      return { kind: "search", title: "Find " + short(i.pattern, 60) };
    case "WebFetch":
      return { kind: "fetch", title: "Fetch " + short(i.url, 80) };
    case "WebSearch":
      return { kind: "fetch", title: "Search the web: " + short(i.query, 60) };
    case "Task":
    case "Agent":
      return { kind: "think", title: "Subagent: " + short(i.description || i.prompt, 70) };
    default: {
      const m = /^mcp__(.+?)__(.+)$/.exec(name || "");
      if (m) return { kind: "other", title: m[1] + ": " + m[2].replace(/_/g, " ") };
      return { kind: "other", title: String(name || "Tool") };
    }
  }
}

// Claude Code's own permission mode for each JAgents chat mode. "Ask" and
// "Auto" both run Claude's default checks; canUseTool then asks the user or
// allows. "Full" skips the checks.
const SDK_MODES = { ask: "default", edits: "acceptEdits", auto: "default", full: "bypassPermissions" };

function sdkPermissionMode(mode) {
  return SDK_MODES[mode] || "default";
}

const DIFF_TEXT_MAX = 20000;
const clipText = (t) => {
  const s = String(t == null ? "" : t);
  return s.length > DIFF_TEXT_MAX ? s.slice(0, DIFF_TEXT_MAX) + "\n…" : s;
};

// What an edit tool changes, as ACP diff content, so the chat draws a diff.
function toolDiffs(name, input) {
  const i = input || {};
  const file = String(i.file_path || i.notebook_path || "");
  if (!file) return [];
  if (name === "Write") return [{ type: "diff", path: file, oldText: null, newText: clipText(i.content) }];
  if (name === "Edit") return [{ type: "diff", path: file, oldText: clipText(i.old_string), newText: clipText(i.new_string) }];
  if (name === "MultiEdit" && Array.isArray(i.edits)) return i.edits.slice(0, 20).map((e) => ({ type: "diff", path: file, oldText: clipText(e && e.old_string), newText: clipText(e && e.new_string) }));
  if (name === "NotebookEdit") return [{ type: "diff", path: file, oldText: null, newText: clipText(i.new_source) }];
  return [];
}

function toolLocations(input) {
  const i = input || {};
  const file = i.file_path || i.notebook_path || (typeof i.path === "string" ? i.path : "");
  return file ? [{ path: String(file) }] : [];
}

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (c && c.type === "text" ? c.text : c && c.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
}

// Message content from a string or {text, attachments}, the same shapes
// AcpClient takes.
function buildSdkContent(input) {
  if (typeof input === "string") return [{ type: "text", text: input }];
  if (Array.isArray(input)) return input;
  const src = input && typeof input === "object" ? input : {};
  return sdkContent(String(src.text || ""), src.attachments || []);
}

// ACP mcpServers entries ({name, command, args, env:[{name,value}]}) to the
// SDK's record of stdio servers.
function sdkMcpServers(entries) {
  const out = {};
  for (const e of entries || []) {
    const env = {};
    for (const item of e.env || []) env[item.name] = item.value;
    out[e.name] = { type: "stdio", command: e.command, args: e.args || [], env };
  }
  return out;
}

class ClaudeSdkClient {
  constructor(options) {
    this.harnessId = options.harnessId;
    this.cwd = options.cwd || options.dataRoot;
    this.mcpServers = options.mcpServers || [];
    // Tools JAgents plugins turned off (Claude Code names: WebFetch, mcp__server__tool).
    this.disallowedTools = options.disallowedTools || [];
    this.onUpdate = options.onUpdate || (() => {});
    // (params) => ACP-shaped permission outcome; see _canUseTool.
    this.onPermission = options.onPermission || null;
    this.permissionMode = options.permissionMode || "ask";
    this.child = null;
    this.query = null;
    this.input = null;
    this.abort = null;
    this.sessionId = null;
    this.started = false;
    this.initialized = false;
    this.models = { availableModels: [], currentModelId: "" };
    this.turn = null;
    this.streamed = new Set();
    this.exitFns = [];
    this.stderrFns = [];
    this.spec = { command: "", env: {} };
    // Same shape as AcpClient's: Claude takes images, PDFs and text documents.
    this.promptCapabilities = { image: true, audio: false, embeddedContext: true };
  }

  start(extra) {
    const o = extra || {};
    this.spec = { command: o.command || "", cwd: o.cwd || this.cwd, env: o.env || {} };
    this.started = true;
    return this;
  }

  onExit(fn) {
    this.exitFns.push(fn);
  }

  onStderr(fn) {
    this.stderrFns.push(fn);
  }

  async initialize() {
    await loadSdk();
    this.initialized = true;
    return { protocolVersion: 1, agentInfo: { name: "claude-code", title: "Claude Code" }, agentCapabilities: { loadSession: true } };
  }

  async newSession(params) {
    const id = randomUUID();
    await this._open({ sessionId: id }, params);
    this.sessionId = id;
    return { sessionId: id, models: this.models };
  }

  async loadSession(sessionId, params) {
    if (!sessionFileExists(sessionId)) throw new Error("Claude Code has no saved session " + sessionId + ".");
    await this._open({ resume: sessionId }, params);
    this.sessionId = sessionId;
    return { models: this.models };
  }

  async _open(identity, params) {
    const { query } = await loadSdk();
    const p = params || {};
    const cwd = p.cwd || this.cwd;
    // A missing folder surfaces from the SDK as a misleading "binary failed to launch".
    if (!cwd || !fs.existsSync(cwd)) throw new Error("Folder not found: " + cwd);
    this.input = new InputQueue();
    this.abort = new AbortController();
    const servers = sdkMcpServers(p.mcpServers || this.mcpServers);
    const options = Object.assign({}, identity, {
      cwd,
      abortController: this.abort,
      includePartialMessages: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      // JAgents has no question UI; Claude asks in plain text instead.
      disallowedTools: ["AskUserQuestion"].concat(this.disallowedTools),
      // The chat's permission mode: Claude asks through canUseTool and the
      // chat shows the card when the mode does not answer by itself.
      permissionMode: sdkPermissionMode(this.permissionMode),
      allowDangerouslySkipPermissions: true,
      canUseTool: (name, input, opts) => this._canUseTool(name, input, opts),
      env: Object.assign({}, process.env, this.spec.env),
      spawnClaudeCodeProcess: (opts) => this._spawn(opts),
    });
    if (Object.keys(servers).length) options.mcpServers = servers;
    if (this.spec.command) options.pathToClaudeCodeExecutable = this.spec.command;
    this.query = query({ prompt: this.input, options });
    this._read(this.query);
    this._loadCommands(this.query);
    const list = await withTimeout(this.query.supportedModels(), MODELS_TIMEOUT_MS, "Claude Code did not start in time.");
    // Each model's effort levels (supportedEffortLevels), for effortState.
    this.modelInfo = Array.isArray(list) ? list : [];
    this.effort = "";
    this.models = {
      availableModels: (list || []).filter((m) => m && m.value).map((m) => ({ modelId: m.value, name: m.displayName || m.value, ...(m.description ? { description: m.description } : {}) })),
      currentModelId: "default",
    };
    if (!this.models.availableModels.some((m) => m.modelId === "default")) this.models.currentModelId = (this.models.availableModels[0] || {}).modelId || "";
  }

  // Claude's permission asks in the same shape as ACP's request_permission, so
  // the host answers both the same way.
  async _canUseTool(name, input, opts) {
    const o = opts || {};
    const allow = { behavior: "allow", updatedInput: input };
    if (!this.onPermission) return allow;
    const info = toolInfo(name, input, this.cwd);
    const options = [{ optionId: "allow_once", name: "Allow", kind: "allow_once" }];
    if (Array.isArray(o.suggestions) && o.suggestions.length && !o.suppressAlwaysAllowRule) options.push({ optionId: "allow_always", name: "Always allow", kind: "allow_always" });
    options.push({ optionId: "reject_once", name: "Deny", kind: "reject_once" });
    const params = {
      sessionId: this.sessionId,
      toolCall: { toolCallId: o.toolUseID, title: info.title, kind: info.kind, rawInput: input, content: toolDiffs(name, input), locations: toolLocations(input) },
      options,
      description: [o.description, o.decisionReason].filter(Boolean).join(" "),
      defaultToNo: Boolean(o.defaultToNo),
      signal: o.signal,
    };
    const res = await this.onPermission(params);
    const picked = res && res.outcome && res.outcome.outcome === "selected" ? res.outcome.optionId : "";
    if (picked === "allow_once") return allow;
    if (picked === "allow_always") return Object.assign({ updatedPermissions: o.suggestions }, allow);
    if (!picked) return { behavior: "deny", message: "The user stopped this turn.", interrupt: true };
    return { behavior: "deny", message: "The user denied this tool call." };
  }

  async setPermissionMode(mode) {
    this.permissionMode = mode;
    if (this.query) await this.query.setPermissionMode(sdkPermissionMode(mode));
  }

  // Slash commands for the composer's menu, as ACP's available_commands_update.
  async _loadCommands(q) {
    try {
      const list = await withTimeout(q.supportedCommands(), MODELS_TIMEOUT_MS, "no commands");
      if (q !== this.query || !Array.isArray(list)) return;
      this._emit({ sessionUpdate: "available_commands_update", availableCommands: list.map((c) => ({ name: c.name, description: c.description || "", input: c.argumentHint ? { hint: c.argumentHint } : null })) });
    } catch {
      /* older Claude Code: no menu */
    }
  }

  // Context window use after each turn, as ACP's usage_update.
  async _reportUsage(q) {
    try {
      const u = await withTimeout(q.getContextUsage({ detail: "summary" }), 10000, "no usage");
      if (q !== this.query || !u || !u.maxTokens) return;
      this._emit({ sessionUpdate: "usage_update", used: u.totalTokens, size: u.maxTokens });
    } catch {
      /* older Claude Code: no ring */
    }
  }

  // Claude Code runs as a hidden child so no console window opens on Windows,
  // and so JAgents knows its pid and exit.
  _spawn(opts) {
    const child = spawnHidden(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], signal: opts.signal });
    this.child = child;
    child.stderr.on("data", (c) => {
      const text = c.toString("utf8");
      for (const fn of this.stderrFns) fn(text);
    });
    // The SDK reports a failed launch itself; this only adds the OS reason when debugging.
    child.on("error", (e) => {
      if (process.env.JAGENTS_DEBUG) console.error("[claude-sdk spawn]", opts.command, opts.cwd, e.message);
    });
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.started = false;
      this._failTurn(new Error("Claude Code exited" + (signal ? ": " + signal : " with code " + code)));
      for (const fn of this.exitFns) fn(code, signal);
    });
    return child;
  }

  async _read(q) {
    try {
      for await (const msg of q) {
        if (q !== this.query) return;
        this._handle(msg);
      }
    } catch (error) {
      if (q === this.query) this._failTurn(error);
    }
  }

  _emit(update) {
    this.onUpdate({ sessionId: this.sessionId, update });
  }

  _handle(msg) {
    if (!msg || typeof msg !== "object") return;
    // Task subagents stream inside the parent's tool call; their row shows the result.
    if (msg.parent_tool_use_id) return;
    if (msg.type === "stream_event") {
      const ev = msg.event || {};
      if (ev.type === "message_start" && ev.message && ev.message.id) this.streamed.add(ev.message.id);
      if (ev.type !== "content_block_delta" || !ev.delta) return;
      if (ev.delta.type === "text_delta" && ev.delta.text) this._emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: ev.delta.text } });
      else if (ev.delta.type === "thinking_delta" && ev.delta.thinking) this._emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: ev.delta.thinking } });
      return;
    }
    if (msg.type === "assistant") {
      const m = msg.message || {};
      const streamed = this.streamed.has(m.id);
      for (const block of Array.isArray(m.content) ? m.content : []) {
        if (block.type === "text" && !streamed && block.text) this._emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.text } });
        else if (block.type === "thinking" && !streamed && block.thinking) this._emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: block.thinking } });
        else if (block.type === "tool_use") this._toolUse(block);
      }
      return;
    }
    if (msg.type === "user") {
      const content = msg.message && msg.message.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (block.type !== "tool_result") continue;
        const text = resultText(block.content).slice(0, TOOL_OUTPUT_MAX);
        this._emit({ sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error ? "failed" : "completed", content: text ? [{ type: "content", content: { type: "text", text } }] : [] });
      }
      return;
    }
    if (msg.type === "result") {
      this._finishTurn(msg);
      if (this.query) this._reportUsage(this.query);
    }
  }

  _toolUse(block) {
    if (block.name === "TodoWrite" && block.input && Array.isArray(block.input.todos)) {
      return this._emit({ sessionUpdate: "plan", entries: block.input.todos.map((t) => ({ content: String(t.content || ""), status: t.status || "pending" })) });
    }
    const info = toolInfo(block.name, block.input, this.cwd);
    this._emit({ sessionUpdate: "tool_call", toolCallId: block.id, title: info.title, kind: info.kind, status: "in_progress", rawInput: block.input, content: toolDiffs(block.name, block.input), locations: toolLocations(block.input) });
  }

  _finishTurn(msg) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (turn.cancelled) return turn.resolve({ stopReason: "cancelled" });
    if (msg.subtype === "success" && !msg.is_error) return turn.resolve({ stopReason: "end_turn" });
    const why = (Array.isArray(msg.errors) && msg.errors.join(" ")) || (typeof msg.result === "string" && msg.result) || msg.subtype || "Claude Code turn failed.";
    turn.reject(new Error(why));
  }

  _failTurn(error) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    if (turn.cancelled) turn.resolve({ stopReason: "cancelled" });
    else turn.reject(error);
  }

  promptWithRecovery(textOrBlocks, sessionId, opts) {
    if (!this.query || !this.started) return Promise.reject(new Error("Claude Code is not running."));
    if (this.turn) return Promise.reject(new Error("The agent is still working on the last message."));
    const signal = opts && opts.signal;
    return new Promise((resolve, reject) => {
      this.turn = { resolve, reject, cancelled: false };
      const onAbort = () => this.cancel();
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        this.input.push({ type: "user", message: { role: "user", content: buildSdkContent(textOrBlocks) }, parent_tool_use_id: null, session_id: sessionId || this.sessionId || "" });
      } catch (error) {
        this.turn = null;
        reject(error);
      }
    });
  }

  async cancel() {
    if (this.turn) this.turn.cancelled = true;
    if (this.query) {
      try {
        await this.query.interrupt();
      } catch {
        /* nothing to interrupt */
      }
    }
  }

  async setModel(modelId) {
    if (!this.query) throw new Error("Start the agent first.");
    if (!this.models.availableModels.some((m) => m.modelId === modelId)) throw new Error("Claude Code did not list model: " + modelId);
    await this.query.setModel(modelId === "default" ? undefined : modelId);
    this.models = Object.assign({}, this.models, { currentModelId: modelId });
    return this.models;
  }

  // Effort levels the current model takes, and the one set for this session
  // ("" until set; Claude Code then uses its own default).
  effortState() {
    const info = this.modelInfo || [];
    const cur = info.find((m) => m && m.value === this.models.currentModelId);
    const pick = cur && cur.supportsEffort !== false && Array.isArray(cur.supportedEffortLevels) ? cur.supportedEffortLevels : cur ? [] : [...new Set(info.flatMap((m) => (m && m.supportsEffort !== false && m.supportedEffortLevels) || []))];
    const names = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
    return { levels: pick.map((v) => ({ value: v, name: names[v] || v })), current: this.effort || "", via: pick.length ? "Claude Code effort" : "" };
  }

  // Same as /effort in Claude Code.
  async setEffort(level) {
    if (!this.query) throw new Error("Start the agent first.");
    if (!this.effortState().levels.some((l) => l.value === level)) throw new Error("This model has no effort level " + level + ".");
    await this.query.applyFlagSettings({ effortLevel: level });
    this.effort = level;
    return this.effortState();
  }

  stop() {
    this.started = false;
    this.initialized = false;
    this._failTurn(new Error("Claude Code stopped."));
    const child = this.child;
    this.child = null;
    this.query = null;
    if (this.input) this.input.end();
    if (this.abort) this.abort.abort();
    if (child && child.exitCode == null) setTimeout(() => child.exitCode == null && killTree(child), 2500).unref();
  }
}

module.exports = { ClaudeSdkClient, toolInfo, toolDiffs, sdkMcpServers, sdkPermissionMode, sessionFileExists };
