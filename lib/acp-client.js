const { encodeNdjson, createFrameParser } = require("./rpc-stdio");
const { createTerminalHub } = require("./acp-terminal");
const { requestTimeoutFor, PROMPT_MS, PROMPT_GRACE_MS, CANCEL_GRACE_MS, TOOL_IDLE_MS } = require("./acp-timeouts");
const { acpPermissionResult } = require("./acp-permissions");
const { readTextFile, writeTextFile } = require("./acp-fs");
const { spawn } = require("child_process");
const { spawnHidden, killTree } = require("./win-command");

// Kept output per terminal: enough for the agent to read results, bounded so
// a runaway child cannot grow memory without bound.
const TERMINAL_OUTPUT_MAX = 256 * 1024;

// Renderer fan-out for terminal chunks is throttled: a spewy child must not
// flood the IPC channel with a snapshot per write.
const TERMINAL_FLUSH_MS = 80;

// ACP sends terminal env as [{ name, value }]; older agents send a map.

function terminalEnv(env) {
  if (Array.isArray(env)) {
    const out = {};
    for (const item of env) if (item && typeof item.name === "string") out[item.name] = String(item.value == null ? "" : item.value);
    return out;
  }
  return env && typeof env === "object" ? env : {};
}

class AcpClient {
  constructor(options) {
    this.harnessId = options.harnessId;
    this.dataRoot = options.dataRoot;
    this.appRoot = options.appRoot;
    this.cwd = options.cwd || options.dataRoot;
    this.mcpServers = options.mcpServers || [];
    this.onUpdate = options.onUpdate || (() => {});
    this.onTerminal = options.onTerminal || (() => {});
    this.onRequest = options.onRequest || null;
    this.terminals = options.terminals || createTerminalHub();
    this.termProcs = new Map();
    this.child = null;
    this.sessionId = null;
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
    this.initialized = false;
    this.models = { availableModels: [], currentModelId: "" };
    this.configOptions = [];
    this.modelConfigId = "";
    this.lastActivity = 0;
    this.openTools = new Set();
    this.agentCalls = 0;
    this.turnCalls = new Set();
    this.turnCancelled = false;
    this.termExits = new Map();
  }

  start(extra) {
    if (this.child && this.started) return this;
    if (this.child) this.stop();
    this.sessionId = null;
    this.models = { availableModels: [], currentModelId: "" };
    this.configOptions = [];
    this.modelConfigId = "";
    const override = extra || {};
    // ACP agents are outside programs: the caller resolves the harness and
    // passes its command and args. There is no built-in harness to spawn.
    if (!(override.command && override.args)) {
      throw new Error("ACP agent " + this.harnessId + " has no spawn command. Install it from the ACP marketplace.");
    }
    const spec = { command: override.command, args: override.args, cwd: override.cwd || this.cwd, env: override.env || {} };
    this.child = spawnHidden(spec.command, spec.args, {
      cwd: spec.cwd || this.cwd,
      env: Object.assign({}, process.env, spec.env || {}),
      stdio: ["pipe", "pipe", "pipe"],
      // Group leader on POSIX so a stop can kill the agent's whole tree;
      // Windows uses taskkill /t instead.
      detached: process.platform !== "win32",
    });
    const child = this.child;
    const parser = createFrameParser((message) => {
      if (this.child === child) this._onMessage(message);
    });
    child.stdout.on("data", (chunk) => parser.push(chunk));
    child.stderr.on("data", () => {});
    const ended = (error) => {
      if (this.child !== child) return;
      this.started = false;
      this.initialized = false;
      this._rejectPending(error);
      this._reapTerminals();
    };
    child.on("error", (error) => ended(error));
    child.on("exit", (code, signal) => ended(new Error("ACP child exited" + (signal ? ": " + signal : " with code " + code))));
    child.on("close", () => ended(new Error("ACP child closed")));
    child.stdin.on("error", (error) => ended(error));
    this.started = true;
    this.initialized = false;
    return this;
  }

  _rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  // Anything the agent sends is a sign of life for the prompt watchdog. Open
  // tool calls and agent-to-client requests (a terminal wait, a file read)
  // count as working even when nothing streams while they run.
  _noteActivity(message) {
    this.lastActivity = Date.now();
    const params = message.method === "session/update" && message.params;
    if (!params) return;
    // Replays and stray sessions must not inflate this turn's working set.
    if (this.sessionId && params.sessionId && params.sessionId !== this.sessionId) return;
    const update = params.update;
    const toolId = update && (update.toolCallId || update.tool_call_id);
    if (!toolId) return;
    const kind = update.sessionUpdate;
    if (kind !== "tool_call" && kind !== "tool_call_update") return;
    const status = update.status;
    if (status === "pending" || status === "in_progress" || (kind === "tool_call" && !status)) {
      this.openTools.add(toolId);
    } else if (status) {
      // Any terminal or adapter-specific status (completed, failed,
      // cancelled) must close the tool; an unknown status left open would
      // stretch the turn's silence budget to the tool idle window.
      this.openTools.delete(toolId);
    }
    // A tool_call_update with no status leaves the entry as it was.
  }

  _onMessage(message) {
    if (!message || typeof message !== "object") return;
    this._noteActivity(message);
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "ACP error");
        error.code = message.error.code;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.method === "session/update") {
      const params = message.params || {};
      if (this.sessionId && params.sessionId && params.sessionId !== this.sessionId) return;
      const update = params.update || {};
      if (update.sessionUpdate === "config_option_update") this.setSessionState({ configOptions: update.configOptions });
      if (update.sessionUpdate === "current_model_update" && typeof update.currentModelId === "string") {
        this.models = Object.assign({}, this.models, { currentModelId: update.currentModelId });
      }
      this.terminals.handle("session/update", params);
      this.onUpdate(params);
      return;
    }
    if (message.method && message.id !== undefined) {
      this.agentCalls++;
      // A per-call token, not the agent's request id: duplicate ids count
      // once in a Set and a stale request finishing mid-turn must not
      // refresh this turn's silence budget.
      const callToken = {};
      this.turnCalls.add(callToken);
      Promise.resolve(this._handleIncoming(message))
        .then((result) => this.respond(message.id, result == null ? {} : result))
        .catch((error) =>
          this.respondError(message.id, error && error.message ? error.message : String(error), error && error.code),
        )
        .finally(() => {
          this.agentCalls--;
          if (this.turnCalls.delete(callToken)) this.lastActivity = Date.now();
        });
    }
  }

  async _handleIncoming(message) {
    if (this.onRequest) {
      const custom = await this.onRequest(message);
      if (custom !== undefined && custom !== null) return custom;
    }
    const method = String(message.method || "");
    const params = message.params || {};
    if (method === "session/request_permission" || method.endsWith("request_permission")) {
      // A cancelled turn must answer cancelled, not auto-approve one more
      // tool call on the way out.
      if (this.turnCancelled) return { outcome: { outcome: "cancelled" } };
      return acpPermissionResult(params, method);
    }
    if (method === "fs/read_text_file" || method.endsWith("read_text_file")) {
      return readTextFile(params, this.cwd);
    }
    if (method === "fs/write_text_file" || method.endsWith("write_text_file")) {
      return writeTextFile(params, this.cwd);
    }
    if (method === "terminal/create") {
      return this._createTerminal(params);
    }
    if (method === "terminal/output") {
      return this._terminalOutput(params);
    }
    if (method === "terminal/wait_for_exit") {
      return this._waitTerminal(params);
    }
    if (method === "terminal/kill") {
      return this._killTerminal(params, false);
    }
    if (method === "terminal/release") {
      return this._killTerminal(params, true);
    }
    const err = new Error("Method not found: " + method);
    err.code = -32601;
    throw err;
  }

  _createTerminal(params) {
    const id = this.terminals.allocate(params && (params.terminalId || params.terminal_id));
    this.terminals.handle("terminal/create", Object.assign({}, params || {}, { terminalId: id }));
    const command = params && params.command;
    const args = params && Array.isArray(params.args) ? params.args : [];
    if (command) {
      // An agent reusing a terminalId would orphan the first child: it stays
      // running, unreachable by kill or reap. Take it down before the map
      // entry is replaced.
      const existing = this.termProcs.get(id);
      if (existing) {
        try {
          if (existing.child) killTree(existing.child);
        } catch {
          /* gone */
        }
        if (existing.finish) existing.finish(existing.exitCode, existing.signal);
        this.termProcs.delete(id);
      }
      const rec = { child: null, exitCode: null, signal: null, output: "", truncated: false, done: null, finish: null, flushTimer: null, flushPending: false };
      rec.done = new Promise((resolve) => {
        rec.finish = (code, signal) => {
          if (rec.exitCode == null && rec.signal == null) {
            rec.exitCode = code == null && !signal ? 1 : code;
            rec.signal = signal || null;
            this.termExits.set(id, { exitCode: rec.exitCode, signal: rec.signal });
          }
          resolve();
        };
      });
      this.termProcs.set(id, rec);
      // Snapshot fan-out is throttled: rec.output updates every chunk but
      // the hub/renderer see a bounded flush rate.
      const flush = () => {
        rec.flushTimer = null;
        if (!rec.flushPending) return;
        rec.flushPending = false;
        this.terminals.handle("terminal/output", { terminalId: id, output: rec.output });
        this.onTerminal({
          method: "terminal/output",
          params: { terminalId: id },
          snapshot: this.terminals.snapshot(),
        });
      };
      const onChunk = (chunk) => {
        // Terminal output is not the agent talking; the agent's own frames
        // (session updates, output polls) keep the watchdog alive, so a
        // spewing child cannot pin a dead turn open forever. Keep a tail
        // window so a runaway child cannot grow memory without bound.
        const text = chunk.toString("utf8");
        const next = rec.output + text;
        if (next.length > TERMINAL_OUTPUT_MAX) rec.truncated = true;
        rec.output = next.slice(-TERMINAL_OUTPUT_MAX);
        rec.flushPending = true;
        if (!rec.flushTimer) rec.flushTimer = setTimeout(flush, TERMINAL_FLUSH_MS);
      };
      const opts = {
        cwd: (params && params.cwd) || this.cwd,
        env: Object.assign({}, process.env, terminalEnv(params.env)),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      };
      try {
        // Agents (Devin) send a whole shell line as `command` with no args.
        // Spawning that as a program name fails with ENOENT, so a line runs
        // through the shell; a bare program with args spawns directly.
        const child = !args.length && /\s/.test(String(command).trim())
          ? spawn(String(command), Object.assign({ shell: true, windowsHide: true }, opts))
          : spawnHidden(command, args, opts);
        rec.child = child;
        if (child.stdout) child.stdout.on("data", onChunk);
        if (child.stderr) child.stderr.on("data", onChunk);
        // Without an error handler a failed spawn is an uncaught exception in
        // the main process and wait_for_exit never answers.
        child.on("error", (error) => {
          onChunk(Buffer.from(String((error && error.message) || error) + "\n"));
          rec.finish(127, null);
        });
        // wait_for_exit resolves on "exit", not "close": close waits for the
        // stdio pipes, which a detached grandchild (daemon, MCP server) can
        // hold open after the command itself is dead.
        child.on("exit", (code, signal) => rec.finish(code, signal));
        child.on("close", (code, signal) => rec.finish(code, signal));
      } catch (error) {
        onChunk(Buffer.from(String((error && error.message) || error) + "\n"));
        rec.finish(127, null);
      }
    }
    this.onTerminal({
      method: "terminal/create",
      params: Object.assign({}, params || {}, { terminalId: id }),
      snapshot: this.terminals.snapshot(),
    });
    return { terminalId: id };
  }

  _terminalOutput(params) {
    const id = String((params && (params.terminalId || params.terminal_id)) || "");
    const rec = this.termProcs.get(id);
    if (rec) {
      // The real process output, plus exitStatus once it ended: an agent
      // polls terminal/output and waits forever without exitStatus.
      const out = { output: rec.output, truncated: Boolean(rec.truncated) };
      if (rec.exitCode != null || rec.signal != null) out.exitStatus = { exitCode: rec.exitCode, signal: rec.signal };
      return out;
    }
    // A released or hub-only terminal still owes the agent an exitStatus
    // when it has one; an agent polling output instead of wait_for_exit
    // would otherwise wait forever. Unknown ids error like wait_for_exit.
    if (!this.terminals.has(id)) throw new Error("Unknown terminal id: " + (id || "(missing)"));
    this.terminals.handle("terminal/output", params || {});
    const row = this.terminals.snapshot().find((item) => item.id === id) || { output: "", truncated: false };
    const out = { output: row.output || "", truncated: Boolean(row.truncated) };
    const exit = this.termExits.get(id);
    if (exit) out.exitStatus = { exitCode: exit.exitCode, signal: exit.signal };
    return out;
  }

  async _waitTerminal(params) {
    const id = String((params && (params.terminalId || params.terminal_id)) || "");
    const rec = this.termProcs.get(id);
    // Reporting exit 0 for a terminal that never existed tells the agent its
    // command succeeded; an error keeps the real failure visible.
    if (!rec) throw new Error("Unknown terminal id: " + (id || "(missing)"));
    await rec.done;
    return { exitCode: rec.exitCode, signal: rec.signal };
  }

  _killTerminal(params, release) {
    const id = String((params && (params.terminalId || params.terminal_id)) || "");
    const rec = this.termProcs.get(id);
    if (rec && rec.child) {
      try {
        killTree(rec.child);
      } catch {
        /* gone */
      }
    }
    // release means the agent is done with the terminal; the record goes
    // with it. kill keeps the output readable for one last poll. Either way
    // any pending wait_for_exit must resolve, not dangle.
    if (release) {
      if (rec) {
        if (rec.flushTimer) clearTimeout(rec.flushTimer);
        if (rec.finish) rec.finish(rec.exitCode, rec.signal);
      }
      this.termProcs.delete(id);
    }
    return {};
  }

  _reapTerminals() {
    for (const [id, rec] of this.termProcs) {
      try {
        if (rec.child) killTree(rec.child);
      } catch {
        /* gone */
      }
      if (rec.flushTimer) clearTimeout(rec.flushTimer);
      if (rec.finish) rec.finish(rec.exitCode, rec.signal);
      this.termExits.delete(id);
    }
    this.termProcs.clear();
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params: params || {} };
    const wait = timeoutMs || requestTimeoutFor(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ACP timeout: " + method));
      }, wait);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.started || !this.child || !this.child.stdin || !this.child.stdin.writable) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("ACP child is not running"));
        return;
      }
      try {
        this.child.stdin.write(encodeNdjson(payload), (error) => {
          if (error) {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            if (pending) pending.reject(error);
          }
        });
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) pending.reject(error);
      }
    });
  }

  // Like request(), but a timeout does not kill the call: the entry stays in
  // `pending` so a late response still resolves the promise, and `timedOut`
  // resolves so the caller can decide what a slow turn means. Used for
  // session/prompt, where the agent legitimately works past the first wait.
  requestSoft(method, params, timeoutMs) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params: params || {} };
    const wait = timeoutMs || requestTimeoutFor(method);
    let timedOutResolve;
    const timedOut = new Promise((resolve) => {
      timedOutResolve = resolve;
    });
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOutResolve();
        // The pending entry stays: a late response still resolves `promise`.
      }, wait);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      if (!this.started || !this.child || !this.child.stdin || !this.child.stdin.writable) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error("ACP child is not running"));
        return;
      }
      try {
        this.child.stdin.write(encodeNdjson(payload), (error) => {
          if (error) {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            if (pending) pending.reject(error);
          }
        });
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) pending.reject(error);
      }
    });
    return { id, promise, timedOut };
  }

  notify(method, params) {
    if (!this.started || !this.child || !this.child.stdin || !this.child.stdin.writable) return;
    // write() on a stream destroyed between the check and the call throws
    // synchronously; a dead stdin just means the reply is lost.
    try {
      this.child.stdin.write(encodeNdjson({ jsonrpc: "2.0", method, params: params || {} }));
    } catch {
      /* dead stdin */
    }
  }

  respond(id, result) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(encodeNdjson({ jsonrpc: "2.0", id, result }));
    } catch {
      /* dead stdin */
    }
  }

  respondError(id, message, code) {
    if (!this.child || !this.child.stdin || !this.child.stdin.writable) return;
    try {
      this.child.stdin.write(
        encodeNdjson({
          jsonrpc: "2.0",
          id,
          error: { code: typeof code === "number" ? code : -32000, message: String(message || "ACP error") },
        }),
      );
    } catch {
      /* dead stdin */
    }
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "relay-ade", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });
    if (!result || result.protocolVersion !== 1) {
      throw new Error("Invalid ACP initialize response: expected protocolVersion 1, got " + JSON.stringify(result && result.protocolVersion) + ".");
    }
    if (!this.started) throw new Error("ACP child is not running");
    this.initialized = true;
    return result;
  }

  sessionNewParams() {
    return { cwd: this.cwd, mcpServers: this.mcpServers || [] };
  }

  setSessionState(result) {
    if (result && result.models) {
      this.models = {
        availableModels: Array.isArray(result.models.availableModels) ? result.models.availableModels.filter((model) => model && typeof model.modelId === "string" && model.modelId.trim()).map((model) => ({ modelId: model.modelId, name: model.name || model.modelId, ...(typeof model.description === "string" ? { description: model.description } : {}) })) : [],
        currentModelId: typeof result.models.currentModelId === "string" ? result.models.currentModelId : "",
      };
    }
    if (result && Array.isArray(result.configOptions)) {
      this.configOptions = result.configOptions;
      if (this.modelConfigId) this.models = { availableModels: [], currentModelId: "" };
      this.modelConfigId = "";
      const model = this.configOptions.find((option) => option && option.type === "select" && typeof option.id === "string" && (option.category === "model" || option.id === "model"));
      if (model) {
        this.modelConfigId = model.id;
        const values = (model.options || []).flatMap((option) => Array.isArray(option && option.options) ? option.options : [option]);
        this.models = {
          availableModels: values.filter((option) => option && typeof option.value === "string" && option.value.trim()).map((option) => ({ modelId: option.value, name: option.name || option.value, ...(typeof option.description === "string" ? { description: option.description } : {}) })),
          currentModelId: typeof model.currentValue === "string" ? model.currentValue : "",
        };
      }
    }
  }

  async newSession(params) {
    const result = await this.request("session/new", params || this.sessionNewParams());
    const sessionId = result && (result.sessionId || result.session_id);
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("Invalid ACP session/new response: missing sessionId.");
    this.sessionId = sessionId;
    this.setSessionState(result);
    return result;
  }

  async setModel(modelId, sessionId) {
    if (!this.models.availableModels.some((model) => model.modelId === modelId)) throw new Error("This agent did not advertise model: " + modelId);
    if (this.models.currentModelId === modelId) return this.models;
    const sid = sessionId || this.sessionId;
    if (!sid) throw new Error("Start the agent first.");
    if (this.modelConfigId) {
      const result = await this.request("session/set_config_option", { sessionId: sid, configId: this.modelConfigId, value: modelId });
      if (!result || !Array.isArray(result.configOptions)) throw new Error("Invalid ACP model configuration response.");
      this.setSessionState(result);
      if (this.models.currentModelId !== modelId) throw new Error("The agent did not select the requested model: " + modelId);
    } else {
      await this.request("session/set_model", { sessionId: sid, modelId });
      this.models = Object.assign({}, this.models, { currentModelId: modelId });
    }
    return this.models;
  }

  async loadSession(sessionId, params) {
    const result = await this.request("session/load", params || Object.assign(this.sessionNewParams(), { sessionId }));
    this.sessionId = sessionId;
    this.setSessionState(result);
    return result;
  }

  async prompt(text, sessionId) {
    const sid = sessionId || this.sessionId;
    try {
      return await this.request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: String(text || "") }],
      });
    } catch (error) {
      // A hard timeout leaves the agent mid-turn while the chat looks idle;
      // at least ask it to stop.
      if (error && /^ACP timeout/.test(error.message)) this.cancel(sid);
      throw error;
    }
  }

  // A turn has no length limit: an agent that keeps streaming, running
  // tools, or waiting on a terminal is working, however long that takes.
  // Only silence counts. After PROMPT_MS + PROMPT_GRACE_MS with nothing from
  // the agent (TOOL_IDLE_MS while a tool call or terminal is still open),
  // ask it to stop and give it a short window to acknowledge. A turn that
  // ignores that too is reported as wedged (the host then restarts the
  // session, which resumes from the persisted transcript).
  async promptWithRecovery(text, sessionId, opts) {
    const options = opts || {};
    const promptMs = options.promptMs || PROMPT_MS;
    const graceMs = options.graceMs == null ? PROMPT_GRACE_MS : options.graceMs;
    const cancelGraceMs = options.cancelGraceMs == null ? CANCEL_GRACE_MS : options.cancelGraceMs;
    const toolIdleMs = options.toolIdleMs || TOOL_IDLE_MS;
    const quietLimit = promptMs + graceMs;
    const sid = sessionId || this.sessionId;
    // The host aborts this signal on Stop: the wait ends and the stop
    // handshake below takes over.
    const signal = options.signal || null;
    let abortAt = 0;
    const onAbort = () => {
      if (!abortAt) abortAt = Date.now();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
    // Open work left over from an earlier turn must not stretch this turn's
    // silence budget: only tools and agent calls that started during this
    // prompt count as working.
    this.openTools.clear();
    this.turnCalls.clear();
    this.turnCancelled = false;
    this.lastActivity = Date.now();
    const req = this.requestSoft(
      "session/prompt",
      { sessionId: sid, prompt: [{ type: "text", text: String(text || "") }] },
      promptMs,
    );
    const answered = req.promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    // A Stop lands as an abort. It is a distinct outcome from a timeout: the
    // caller has already asked to stop, so the wait ends now instead of
    // burning the rest of the silence budget.
    const ABORTED = Symbol("aborted");
    const settle = (ms, watchAbort = true) => {
      let timer;
      let abortFn;
      const racers = [answered, new Promise((resolve) => (timer = setTimeout(() => resolve(null), ms)))];
      if (signal && watchAbort) {
        racers.push(
          new Promise((resolve) => {
            if (signal.aborted) resolve(ABORTED);
            else signal.addEventListener("abort", (abortFn = () => resolve(ABORTED)), { once: true });
          }),
        );
      }
      return Promise.race(racers).finally(() => {
        clearTimeout(timer);
        if (signal && abortFn) signal.removeEventListener("abort", abortFn);
      });
    };
    try {
      for (;;) {
        // The abort can land between the initial aborted check and the
        // listener registration; without this the loop spins forever.
        if (signal && signal.aborted && !abortAt) abortAt = Date.now();
        // A stop ends the wait there and then: waiting for the remaining
        // silence budget on a turn the user just cancelled only delays the
        // stop handshake below.
        if (abortAt) break;
        const working = this.openTools.size > 0 || this.turnCalls.size > 0;
        const left = (working ? toolIdleMs : quietLimit) - (Date.now() - this.lastActivity);
        if (left <= 0) break;
        const outcome = await settle(left);
        if (outcome === ABORTED) {
          if (!abortAt) abortAt = Date.now();
          break;
        }
        if (outcome) {
          if (outcome.error) throw outcome.error;
          return outcome.value;
        }
      }
      // Out of silence budget, or the user pressed Stop: ask the agent to stop
      // and give it the whole cancel grace to answer with stopReason
      // cancelled. That grace never races the abort signal again, because the
      // grace exists precisely because the turn was cut short; racing it made
      // the wait end on the same aborted signal and reported a cooperative
      // agent as wedged.
      const idleMs = Date.now() - this.lastActivity;
      this.cancel(sid);
      const stopped = await settle(cancelGraceMs, false);
      if (stopped) {
        if (stopped.error) throw stopped.error;
        // idleStopped only marks a silence timeout; a user cancel already
        // says "Turn stopped." through its own stopReason.
        return Object.assign({}, stopped.value, { idleStopped: !abortAt, idleMs });
      }
      this.pending.delete(req.id);
      throw new Error("The agent went silent and did not stop when asked. Start the agent again to continue.");
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
  }

  async cancel(sessionId) {
    const sid = sessionId || this.sessionId;
    this.turnCancelled = true;
    this.notify("session/cancel", { sessionId: sid });
  }

  // Tearing the process down mid-turn yanks the agent's stream out from under
  // it, and the reply it was writing ends on "Error: RetriableError:
  // WritableIterable is closed". That leak is persisted with the chat and the
  // saved session replays it on every resume, so every later turn dies the
  // same way. Tell the agent to abort the turn first; it is a notification, so
  // nothing waits on the dying process to answer it.
  stop(sessionId) {
    const sid = sessionId || this.sessionId;
    if (this.started && this.child && sid && !this.turnCancelled) {
      try {
        this.notify("session/cancel", { sessionId: sid });
      } catch {
        /* the stream is already gone */
      }
    }
    this.started = false;
    this.initialized = false;
    this._rejectPending(new Error("ACP client stopped"));
    this._reapTerminals();
    if (this.child) {
      try {
        if (this.child.stdin) this.child.stdin.end();
      } catch {
        /* gone */
      }
      killTree(this.child);
      try {
        this.child.unref();
      } catch {
        /* gone */
      }
      this.child = null;
    }
    this.started = false;
  }
}

module.exports = { AcpClient, requestTimeoutFor };
