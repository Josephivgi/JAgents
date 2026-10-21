#!/usr/bin/env node
"use strict";

// A scripted ACP agent for host tests only. Each prompt "<kind> <seconds>"
// opens one tool call of that kind, asks permission for it, waits the given
// seconds when allowed, and ends the turn. It reports the outcome it got in
// its reply text so tests can read it back.

let buf = "";
let nextId = 1000;
const waiting = new Map();

function send(msg) {
  process.stdout.write(JSON.stringify(Object.assign({ jsonrpc: "2.0" }, msg)) + "\n");
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function update(sessionId, u) {
  send({ method: "session/update", params: { sessionId, update: u } });
}

async function prompt(id, params) {
  const sessionId = params.sessionId;
  const text = (params.prompt || []).map((b) => b.text || "").join(" ");
  const m = /(read|edit|execute|other)\s*(\d*)/.exec(text.split("\n").pop()) || [];
  const kind = m[1] || "other";
  const wait = Number(m[2] || 0) * 1000;
  const toolCallId = "t" + nextId++;
  update(sessionId, { sessionUpdate: "tool_call", toolCallId, title: "Do " + kind, kind, status: "pending", rawInput: { command: "echo " + kind } });
  const res = await request("session/request_permission", {
    sessionId,
    toolCall: { toolCallId, title: "Do " + kind, kind },
    options: [
      { optionId: "yes", name: "Allow once", kind: "allow_once" },
      { optionId: "yes-always", name: "Allow always", kind: "allow_always" },
      { optionId: "no", name: "Reject", kind: "reject_once" },
    ],
  });
  const outcome = res && res.outcome ? (res.outcome.outcome === "selected" ? res.outcome.optionId : res.outcome.outcome) : "none";
  const allowed = outcome === "yes" || outcome === "yes-always";
  if (allowed && wait) await new Promise((r) => setTimeout(r, wait));
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: allowed ? "completed" : "failed" });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "outcome:" + outcome } });
  send({ id, result: { stopReason: outcome === "cancelled" ? "cancelled" : "end_turn" } });
}

function onMessage(msg) {
  if (msg.id !== undefined && waiting.has(msg.id) && (msg.result !== undefined || msg.error)) {
    const fn = waiting.get(msg.id);
    waiting.delete(msg.id);
    return fn(msg.result);
  }
  if (msg.method === "initialize") return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, agentInfo: { name: "fake" } } });
  if (msg.method === "session/new") return send({ id: msg.id, result: { sessionId: "s1" } });
  if (msg.method === "session/prompt") return prompt(msg.id, msg.params || {});
  if (msg.method === "session/cancel") return;
  if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: "no " + msg.method } });
}

process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) onMessage(JSON.parse(line));
  }
});
