"use strict";

// ACP chat sessions (chat panes, threads, and hub-spawned subagents). Adapted
// from Plugin App's acp-host.cjs: spawn the agent, initialize, session/load when
// the agent can and the chat has a saved session, otherwise session/new, then
// stream session/update into a transcript the renderer draws. Relay adds a
// per-chat working folder, a parent (the agent that spawned a subagent),
// waitTurn for the hub, a delivery queue for messages that arrive mid-turn, and
// incoming handoffs from other panes.

const { randomUUID } = require("node:crypto");
const { AcpClient } = require("../lib/acp-client");
const { ClaudeSdkClient } = require("../lib/claude-sdk-client");
const { acpAgent, listAcpAgents, acpSpawnSpec } = require("../lib/agents");

// Claude Code chats use the native Agent SDK client; everything else speaks ACP.
function makeClient(harnessId, options) {
  const agent = acpAgent(harnessId);
  return agent && agent.native === "claude-sdk" ? new ClaudeSdkClient(options) : new AcpClient(options);
}

// Exit and stderr hooks: the native client spawns its process later, so it
// takes callbacks; ACP clients expose the child right after start().
function watchClient(client, onStderr, onExit) {
  if (typeof client.onExit === "function") {
    client.onStderr(onStderr);
    client.onExit(onExit);
  } else if (client.child) {
    if (client.child.stderr) client.child.stderr.on("data", (c) => onStderr(c.toString("utf8")));
    client.child.on("exit", onExit);
  }
}
const { handoffPrompt, toolDetail } = require("../lib/acp-handoff");

const TRANSCRIPT_MAX = 800;
const HISTORY_MAX = 8000;

function lastRow(rows, test) {
  for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i])) return rows[i];
  return null;
}

// Devin's ACP server ignores session/new mcpServers and reads its config files,
// so the Relay entry also goes into the cwd's local Devin config (as Plugin App does).
function writeDevinMcpConfig(cwd, entries) {
  const fs = require("node:fs");
  const path = require("node:path");
  if (!cwd || !entries.length) return;
  const dir = path.join(cwd, ".devin");
  const file = path.join(dir, "mcp_config.local.json");
  fs.mkdirSync(dir, { recursive: true });
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cannot read Devin MCP config. Existing config was not changed.");
  }
  const servers = Object.assign({}, current.mcpServers);
  for (const entry of entries) {
    const env = {};
    for (const item of entry.env || []) env[item.name] = item.value;
    servers[entry.name] = { command: entry.command, args: entry.args || [], env };
  }
  const tmp = file + "." + randomUUID() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, current, { mcpServers: servers }), null, 2));
  fs.renameSync(tmp, file);
}

function createAcpHost(options) {
  const { dataRoot, db, emit, defaultCwd, mcpEntryFor, contextFor, disallowedFor } = options;
  const sessions = new Map();
  const probes = new Map();
  const saveTimers = new Map();
  const emitTimers = new Map();
  const turnWaiters = new Map(); // chatId -> Set<fn>
  const queues = new Map(); // chatId -> [{text, from}]

  function chatRecord(chatId) {
    const chat = db.getChat(chatId);
    if (!chat) throw new Error("That chat no longer exists.");
    return chat;
  }

  function snapshot(chatId) {
    const s = sessions.get(chatId);
    const chat = db.getChat(chatId);
    if (!chat) return null;
    return {
      chatId,
      title: chat.title,
      harnessId: chat.harnessId,
      handle: chat.handle,
      parentId: chat.parentId,
      cwd: chat.cwd,
      status: s ? s.status : "idle",
      error: s ? s.error : "",
      agentName: s ? s.agentName : (acpAgent(chat.harnessId) || {}).name || chat.harnessId,
      models: s && s.client ? s.client.models : { availableModels: [], currentModelId: "" },
      queued: (queues.get(chatId) || []).length,
      transcript: s ? s.transcript : chat.transcript,
    };
  }

  function saveModelCatalog(harnessId, models) {
    if (models && Array.isArray(models.availableModels) && models.availableModels.length) {
      try {
        db.setSetting("agent-models:" + harnessId, models);
      } catch {
        /* best effort */
      }
    }
  }

  function modelPref(harnessId) {
    return String(db.getSetting("agent-model:" + harnessId, "") || "");
  }

  async function applyModelPref(harnessId, client, sessionId) {
    const pref = modelPref(harnessId);
    if (!pref || !client) return;
    if (!client.models.availableModels.some((m) => m.modelId === pref)) return;
    if (client.models.currentModelId === pref) return;
    try {
      await client.setModel(pref, sessionId);
    } catch {
      /* the agent declined; leave its own default */
    }
  }

  function mcpServersFor(chatId) {
    const entries = mcpEntryFor(chatId);
    return Array.isArray(entries) ? entries : entries ? [entries] : [];
  }

  function probeState(harnessId) {
    const p = probes.get(harnessId);
    return {
      harnessId,
      probing: Boolean(p && p.status === "probing"),
      error: p && p.status === "error" ? p.error : "",
      models: p && p.client ? p.client.models : db.getSetting("agent-models:" + harnessId, null),
    };
  }

  function emitProbe(harnessId) {
    emit("acp-models", probeState(harnessId));
  }

  // A probe is a live session opened only to learn the agent's model list
  // before any chat exists. Unlike Plugin App, chats do not adopt it: each chat
  // has its own folder and MCP identity, so the probe stops once it has the list.
  async function probe(harnessId) {
    const id = String(harnessId || "");
    const agent = acpAgent(id);
    if (!agent) throw new Error("Unknown agent: " + id);
    const existing = probes.get(id);
    if (existing && (existing.status === "probing" || existing.status === "done")) return modelInfo(id);
    if (existing && existing.status === "error" && Date.now() - existing.failedAt < 15000) return modelInfo(id);
    let spec;
    try {
      spec = acpSpawnSpec(id);
    } catch {
      return modelInfo(id);
    }
    const p = { status: "probing", error: "", failedAt: 0, client: null };
    probes.set(id, p);
    emitProbe(id);
    (async () => {
      let stderr = "";
      try {
        const cwd = defaultCwd();
        const client = makeClient(id, { harnessId: id, dataRoot, cwd, mcpServers: [] });
        p.client = client;
        client.start({ command: spec.command, args: spec.args, cwd, env: spec.env });
        watchClient(client, (t) => (stderr = (stderr + t).slice(-2000)), () => {});
        await client.initialize();
        await client.newSession({ cwd, mcpServers: [] });
        saveModelCatalog(id, client.models);
        p.models = client.models;
        p.status = "done";
      } catch (error) {
        p.status = "error";
        p.failedAt = Date.now();
        p.error = String(error.message || error) + (stderr ? " " + stderr.trim().split("\n").pop() : "");
      } finally {
        if (p.client) {
          const models = p.client.models;
          p.client.stop();
          p.client = null;
          if (p.status === "done") p.models = models;
        }
      }
      emitProbe(id);
    })();
    return modelInfo(id);
  }

  function notifyTurn(chatId) {
    const set = turnWaiters.get(chatId);
    if (!set) return;
    const s = sessions.get(chatId);
    if (s && (s.status === "busy" || s.status === "starting")) return;
    for (const fn of Array.from(set)) fn();
  }

  function emitState(chatId, now) {
    clearTimeout(emitTimers.get(chatId));
    const fire = () => {
      emitTimers.delete(chatId);
      const snap = snapshot(chatId);
      if (snap) emit("acp-state", snap);
    };
    if (now) fire();
    else emitTimers.set(chatId, setTimeout(fire, 50));
  }

  function persist(s, now) {
    clearTimeout(saveTimers.get(s.chatId));
    const save = () => {
      saveTimers.delete(s.chatId);
      const chat = db.getChat(s.chatId);
      if (!chat) return;
      db.saveChat(Object.assign(chat, { acpSessionId: s.sessionId || chat.acpSessionId, transcript: s.transcript.slice(-TRANSCRIPT_MAX), title: s.title || chat.title }), { forHarness: s.harnessId });
    };
    if (now) save();
    else saveTimers.set(s.chatId, setTimeout(save, 400));
  }

  function push(s, row) {
    s.transcript.push(Object.assign({ at: Date.now() }, row));
    if (s.transcript.length > TRANSCRIPT_MAX) s.transcript.splice(0, s.transcript.length - TRANSCRIPT_MAX);
    persist(s);
    emitState(s.chatId);
  }

  function onUpdate(s, params) {
    if (params && params.sessionId && s.sessionId && params.sessionId !== s.sessionId) return;
    if (s.replaying) return;
    const u = (params && params.update) || {};
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const textPart = u.content && u.content.type === "text" ? String(u.content.text || "") : "";
      if (!textPart) return;
      const role = kind === "agent_message_chunk" ? "agent" : "thought";
      const last = s.transcript[s.transcript.length - 1];
      if (last && last.role === role) last.text += textPart;
      else return push(s, { role, text: textPart });
    } else if (kind === "tool_call") {
      return push(s, Object.assign({ role: "tool", toolCallId: u.toolCallId, title: String(u.title || "Tool call"), status: u.status || "pending" }, toolDetail(u)));
    } else if (kind === "tool_call_update") {
      const row = lastRow(s.transcript, (r) => r.role === "tool" && r.toolCallId === u.toolCallId);
      if (!row) return;
      if (u.status) row.status = u.status;
      if (u.title) row.title = String(u.title);
      const detail = toolDetail(u);
      if (detail.kind) row.kind = detail.kind;
      if (detail.input) row.input = detail.input;
      if (detail.output) row.output = detail.output;
    } else if (kind === "plan" && Array.isArray(u.entries)) {
      const existing = lastRow(s.transcript, (r) => r.role === "plan");
      const entries = u.entries.map((e) => ({ content: String(e.content || ""), status: e.status || "pending" }));
      if (existing && s.transcript.indexOf(existing) >= s.turnStart) existing.entries = entries;
      else return push(s, { role: "plan", entries });
    } else if (kind === "config_option_update" || kind === "current_model_update") {
      // models changed in the client
    } else {
      return;
    }
    persist(s);
    emitState(s.chatId);
  }

  function historyPrefix(rows) {
    const lines = [];
    for (const row of rows.slice(-60)) {
      const t = String(row.text || "").replace(/\s+/g, " ").trim().slice(0, 800);
      if (row.role === "user" && t) lines.push("User: " + t);
      else if (row.role === "agent" && t) lines.push("Agent: " + t);
    }
    if (!lines.length) return "";
    let body = lines.join("\n");
    if (body.length > HISTORY_MAX) body = body.slice(-HISTORY_MAX);
    return "This chat was restored and the earlier agent session could not be loaded. Prior conversation:\n" + body;
  }

  // An incoming cross-pane handoff (lib/handoff.js) that no prompt has carried yet.
  function pendingHandoffIn(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.role === "user") return "";
      if (row.role === "system" && row.kind === "handoff-in" && !row.consumed) return row.instruction || "";
    }
    return "";
  }

  function firstPromptPrefix(transcript, harnessId, chatId) {
    return handoffPrompt(transcript, { harnessId, chatId }) || historyPrefix(transcript.filter((r) => !(r.role === "system" && r.kind === "handoff-in")));
  }

  function dispose(s) {
    s.disposed = true;
    if (s.turn) s.turn.abort();
    if (s.client) s.client.stop();
  }

  async function start(chatId) {
    const existing = sessions.get(chatId);
    if (existing && !existing.disposed) {
      if (existing.startPromise) return existing.startPromise;
      if (existing.status === "ready" || existing.status === "busy") return snapshot(chatId);
      dispose(existing);
    }
    const chat = chatRecord(chatId);
    const agent = acpAgent(chat.harnessId);
    if (!agent) throw new Error("Unknown agent: " + chat.harnessId);
    const s = {
      chatId, title: chat.title, harnessId: chat.harnessId, status: "starting", error: "", agentName: agent.name,
      transcript: (existing && existing.transcript) || chat.transcript.slice(), sessionId: "", client: null, turn: null,
      prefix: "", contextSent: false, disposed: false, replaying: false, turnStart: 0,
    };
    for (const row of s.transcript) if (row.role === "tool" && (row.status === "pending" || row.status === "in_progress")) row.status = "cancelled";
    sessions.set(chatId, s);
    emitState(chatId, true);
    s.startPromise = (async () => {
      let stderr = "";
      try {
        const spec = acpSpawnSpec(chat.harnessId);
        const cwd = chat.cwd || defaultCwd();
        const mcpServers = mcpServersFor(chatId);
        if (chat.harnessId === "devin") writeDevinMcpConfig(cwd, mcpServers);
        const client = makeClient(chat.harnessId, { harnessId: chat.harnessId, dataRoot, cwd, mcpServers, disallowedTools: disallowedFor ? disallowedFor(chatId) : [], onUpdate: (p) => onUpdate(s, p) });
        s.client = client;
        const env = Object.assign({ RELAY_PANE_ID: chatId }, spec.env);
        client.start({ command: spec.command, args: spec.args, cwd, env });
        watchClient(client, (t) => (stderr = (stderr + t).slice(-2000)), (code, signal) => {
          if (s.disposed || sessions.get(chatId) !== s) return;
          // A failed start already stopped the agent; keep its error (sign-in hints) on screen.
          if (s.status === "error" && s.error) {
            s.client = null;
            return emitState(chatId, true);
          }
          const midTurn = s.status === "busy";
          s.status = midTurn || (code && code !== 0) ? "error" : "idle";
          s.error = s.status === "error" ? "Agent exited" + (signal ? ": " + signal : " with code " + code) + (stderr ? ": " + stderr.trim().split("\n").pop() : "") : "";
          s.client = null;
          emitState(chatId, true);
          notifyTurn(chatId);
        });
        const init = await client.initialize();
        if (s.disposed) throw new Error("Stopped.");
        s.agentName = (init && init.agentInfo && (init.agentInfo.title || init.agentInfo.name)) || agent.name;
        const canLoad = Boolean(init && init.agentCapabilities && init.agentCapabilities.loadSession);
        const params = { cwd, mcpServers };
        let resumed = false;
        if (chat.acpSessionId && canLoad) {
          s.replaying = true;
          try {
            await client.loadSession(chat.acpSessionId, Object.assign({}, params, { sessionId: chat.acpSessionId }));
            s.sessionId = chat.acpSessionId;
            resumed = true;
          } catch {
            /* expired on the agent side; start a fresh session */
          } finally {
            s.replaying = false;
          }
        }
        if (!resumed) {
          const created = await client.newSession(params);
          s.sessionId = created.sessionId || created.session_id;
          s.prefix = firstPromptPrefix(s.transcript, s.harnessId, chatId);
        } else {
          s.contextSent = true;
        }
        s.status = "ready";
        saveModelCatalog(s.harnessId, client.models);
        await applyModelPref(s.harnessId, client, s.sessionId);
        persist(s, true);
        return snapshot(chatId);
      } catch (error) {
        const auth = /auth/i.test(String(error.message || ""));
        s.status = "error";
        s.error = String(error.message || error) + (stderr && !auth ? " " + stderr.trim().split("\n").pop() : "") + (auth ? " Sign in to " + agent.name + " first (" + agent.install + ")" : "");
        if (s.client) s.client.stop();
        s.client = null;
        throw new Error(s.error);
      } finally {
        s.startPromise = null;
        emitState(chatId, true);
        notifyTurn(chatId);
      }
    })();
    return s.startPromise;
  }

  function titleFrom(text) {
    return String(text).replace(/\s+/g, " ").trim().slice(0, 60) || "New thread";
  }

  async function prompt(chatId, textIn, meta) {
    const userText = String(textIn || "").trim();
    if (!userText) throw new Error("Type a message first.");
    const from = (meta && meta.from) || "";
    let s = sessions.get(chatId);
    if (s && (s.status === "busy" || (s.startPromise && s.status === "starting"))) throw new Error("The agent is still working on the last message.");
    const userRow = { role: "user", text: userText };
    if (from) userRow.from = from;
    if (!s || s.disposed || s.status !== "ready") {
      const chat = chatRecord(chatId);
      const rows = (s && !s.disposed && s.transcript) || chat.transcript.slice();
      rows.push(Object.assign({ at: Date.now() }, userRow));
      if (chat.title === "New thread") chat.title = titleFrom(userText);
      db.saveChat(Object.assign(chat, { transcript: rows }));
      if (s && !s.disposed) s.transcript = rows;
      await start(chatId);
      s = sessions.get(chatId);
      s.title = db.getChat(chatId).title;
    } else {
      push(s, userRow);
      const chat = db.getChat(chatId);
      if (chat && chat.title === "New thread") s.title = titleFrom(userText);
    }
    // The cross-pane handoff note rides on the first prompt after it landed.
    let handoffIn = "";
    for (let i = s.transcript.length - 2; i >= 0; i--) {
      const row = s.transcript[i];
      if (row.role === "user") break;
      if (row.role === "system" && row.kind === "handoff-in" && !row.consumed) {
        handoffIn = row.instruction || "";
        row.consumed = true;
        break;
      }
    }
    const parts = [];
    if (!s.contextSent) parts.push(contextFor(chatId));
    if (s.prefix) parts.push(s.prefix);
    if (handoffIn) parts.push(handoffIn);
    const said = from ? "Message from " + from + " (another agent, via Relay):\n" + userText : userText;
    parts.push(parts.length ? (from ? said : "User request:\n" + userText) : said);
    s.contextSent = true;
    s.prefix = "";
    s.status = "busy";
    s.turnStart = s.transcript.length;
    s.turn = new AbortController();
    s.lastUserRow = s.transcript.length - 1;
    emitState(chatId, true);
    try {
      const result = await s.client.promptWithRecovery(parts.join("\n\n"), s.sessionId, { signal: s.turn.signal });
      if (result && result.stopReason === "cancelled") push(s, { role: "system", text: "Stopped." });
      else if (result && result.stopReason && result.stopReason !== "end_turn") push(s, { role: "system", text: "Turn ended: " + result.stopReason + "." });
      s.status = "ready";
    } catch (error) {
      s.status = s.client && s.client.started ? "ready" : "error";
      s.error = s.status === "error" ? String(error.message || error) : "";
      push(s, { role: "error", text: String(error.message || error) });
    } finally {
      s.turn = null;
      persist(s, true);
      emitState(chatId, true);
      notifyTurn(chatId);
      setTimeout(() => drainQueue(chatId), 0);
    }
    return snapshot(chatId);
  }

  // Messages from other agents that land while this one is mid-turn wait here
  // and go out, in order, when the turn ends.
  function deliver(chatId, text, from) {
    const s = sessions.get(chatId);
    const busy = s && !s.disposed && (s.status === "busy" || s.status === "starting");
    if (busy) {
      const q = queues.get(chatId) || [];
      q.push({ text, from });
      queues.set(chatId, q);
      emitState(chatId, true);
      return { delivered: false, queued: q.length };
    }
    prompt(chatId, text, { from }).catch(() => {});
    return { delivered: true, queued: 0 };
  }

  function drainQueue(chatId) {
    const q = queues.get(chatId);
    if (!q || !q.length) return;
    const s = sessions.get(chatId);
    if (s && (s.status === "busy" || s.status === "starting")) return;
    const next = q.shift();
    if (!q.length) queues.delete(chatId);
    prompt(chatId, next.text, { from: next.from }).catch(() => {});
  }

  function isBusy(chatId) {
    const s = sessions.get(chatId);
    return Boolean(s && !s.disposed && (s.status === "busy" || s.status === "starting" || (queues.get(chatId) || []).length));
  }

  // Resolves when the chat has no turn running and nothing queued, or after timeoutMs.
  function waitTurn(chatId, timeoutMs) {
    return new Promise((resolve) => {
      if (!isBusy(chatId)) return resolve("idle");
      let set = turnWaiters.get(chatId);
      if (!set) turnWaiters.set(chatId, (set = new Set()));
      const done = (why) => {
        clearTimeout(timer);
        set.delete(check);
        resolve(why);
      };
      const check = () => setTimeout(() => !isBusy(chatId) && done("idle"), 20);
      const timer = setTimeout(() => done("timeout"), timeoutMs || 50000);
      set.add(check);
    });
  }

  // The agent's answer to the latest prompt: agent rows after the last user row.
  function lastReply(chatId) {
    const snap = snapshot(chatId);
    if (!snap) return "";
    const rows = snap.transcript;
    let i = rows.length - 1;
    while (i >= 0 && rows[i].role !== "user") i--;
    const parts = rows.slice(i + 1).filter((r) => r.role === "agent" || r.role === "error").map((r) => (r.role === "error" ? "[error] " : "") + r.text);
    return parts.join("\n\n").trim();
  }

  function cancel(chatId) {
    const s = sessions.get(chatId);
    queues.delete(chatId);
    if (s && s.turn) s.turn.abort();
    return { ok: true };
  }

  async function setModel(chatId, modelId) {
    const s = sessions.get(chatId);
    // No live session yet (or still starting): keep the choice; start() applies
    // it through applyModelPref once the agent has a session.
    if (!s || s.disposed || !s.client || !s.sessionId || s.status === "starting") {
      await setModelPref(chatRecord(chatId).harnessId, modelId);
      emitState(chatId, true);
      return snapshot(chatId);
    }
    await s.client.setModel(String(modelId), s.sessionId);
    db.setSetting("agent-model:" + s.harnessId, String(modelId));
    saveModelCatalog(s.harnessId, s.client.models);
    emitState(chatId, true);
    return snapshot(chatId);
  }

  function modelInfo(harnessId) {
    const id = String(harnessId || "");
    return Object.assign({ preferred: modelPref(id) }, probeState(id));
  }

  async function setModelPref(harnessId, modelId) {
    const id = String(harnessId || "");
    const mid = String(modelId || "");
    db.setSetting("agent-model:" + id, mid);
    for (const s of sessions.values()) {
      if (s.disposed || s.harnessId !== id || !s.client || s.client.models.currentModelId === mid) continue;
      try {
        await s.client.setModel(mid, s.sessionId);
        emitState(s.chatId);
      } catch {
        /* next start applies the pref */
      }
    }
    return modelInfo(id);
  }

  function createChat(input) {
    const src = input || {};
    const id = src.id || randomUUID();
    db.createChat({ id, title: src.title || "New thread", harnessId: src.harnessId || "devin", cwd: src.cwd || defaultCwd(), parentId: src.parentId || "", handle: src.handle || "", transcript: src.transcript || [] });
    emit("chats-changed", {});
    return snapshot(id);
  }

  // A cross-pane handoff landed on this chat: show it as a marker and carry the
  // instruction on the next prompt.
  function receiveHandoff(chatId, row) {
    const s = sessions.get(chatId);
    const full = Object.assign({ role: "system", kind: "handoff-in", at: Date.now() }, row);
    if (s && !s.disposed) return push(s, full);
    const chat = chatRecord(chatId);
    chat.transcript.push(full);
    db.saveChat(chat);
    emitState(chatId, true);
  }

  // In-thread agent switch (Plugin App's handoff).
  function handoff(chatId, harnessId) {
    const id = String(chatId || "");
    const next = String(harnessId || "");
    const agent = acpAgent(next);
    if (!agent) throw new Error("Unknown agent: " + next);
    const chat = chatRecord(id);
    const from = String(chat.harnessId || "");
    if (from === next) return snapshot(id);
    const s = sessions.get(id);
    if (s && (s.status === "busy" || s.status === "starting")) throw new Error("Wait for the current turn to finish before switching agents.");
    const live = s && Array.isArray(s.transcript) ? s.transcript.map((row) => Object.assign({}, row)) : null;
    if (s) {
      clearTimeout(saveTimers.get(id));
      saveTimers.delete(id);
      dispose(s);
      sessions.delete(id);
    }
    const fromAgent = acpAgent(from);
    db.switchChatHarness(id, { harnessId: next, fromName: (fromAgent && fromAgent.name) || from, toName: agent.name, liveTranscript: live });
    emitState(id, true);
    emit("chats-changed", {});
    return snapshot(id);
  }

  function stopChat(chatId) {
    const s = sessions.get(chatId);
    if (s) {
      persist(s, true);
      dispose(s);
      sessions.delete(chatId);
    }
    queues.delete(chatId);
    emitState(chatId, true);
    notifyTurn(chatId);
  }

  function deleteChat(chatId) {
    stopChat(chatId);
    clearTimeout(saveTimers.get(chatId));
    const ok = db.deleteChat(chatId);
    emit("chats-changed", {});
    return ok;
  }

  function stopAll() {
    for (const s of sessions.values()) {
      persist(s, true);
      dispose(s);
    }
    sessions.clear();
    for (const p of probes.values()) if (p.client) p.client.stop();
    probes.clear();
  }

  function liveIds() {
    return Array.from(sessions.values()).filter((s) => !s.disposed).map((s) => s.chatId);
  }

  function childPid(chatId) {
    const s = sessions.get(chatId);
    return s && s.client && s.client.child ? s.client.child.pid : 0;
  }

  return {
    listAgents: listAcpAgents,
    listChats: () => db.listChats(),
    snapshot,
    createChat,
    handoff,
    receiveHandoff,
    deleteChat,
    stopChat,
    start,
    prompt,
    deliver,
    waitTurn,
    lastReply,
    isBusy,
    cancel,
    setModel,
    modelInfo,
    setModelPref,
    probe,
    stopAll,
    liveIds,
    childPid,
  };
}

module.exports = { createAcpHost };
