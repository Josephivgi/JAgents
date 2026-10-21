"use strict";

const { describeAttachments } = require("./attachments");

// Context handoff between ACP agents, adapted from Plugin App and Cutline desktop. A
// chat can switch agents mid-thread: the outgoing agent's session cannot
// be resumed by another agent, so the incoming one starts a fresh session and
// its first prompt carries the prior conversation as text (messages plus the
// tool trail). Older or truncated rows stay readable through the
// jagents_read_chat MCP tool.

const HANDOFF_KIND = "handoff";
// The whole handoff block, and one rendered row inside it.
const HANDOFF_BUDGET = 24000;
const HANDOFF_ROW_MAX = 3000;
// Tool input/output kept on a transcript row.
const TOOL_DETAIL_MAX = 1500;
// Tool output and diffs the chat shows; prompts clip them again.
const TOOL_OUTPUT_MAX = 8000;
const DIFF_TEXT_MAX = 20000;
const DIFFS_MAX = 20;
const READ_ROW_MAX = 6000;
const READ_FULL_MAX = 60000;
const READ_LIMIT_DEFAULT = 40;
const READ_LIMIT_MAX = 200;

function clip(text, max) {
  const value = String(text == null ? "" : text);
  return value.length > max ? value.slice(0, max) + " [cut, " + (value.length - max) + " more characters]" : value;
}

function harnessName(id, name) {
  return String(name || id || "the previous agent");
}

// Secrets never belong in a transcript that another agent reads back: cookie
// values, tokens, and keys are replaced before the row is written. Same key
// list the Cutline activity log uses.
function redactArgs(args) {
  const seen = new WeakSet();
  const walk = (value, key) => {
    if (/cookie|token|password|secret|authorization|api[_-]?key/i.test(String(key || ""))) {
      if (value == null) return value;
      if (Array.isArray(value)) return "[redacted " + value.length + "]";
      return "[redacted]";
    }
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => walk(item, ""));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k);
    return out;
  };
  try {
    const json = JSON.stringify(walk(args || {}, "") || {});
    return json === undefined ? "{}" : json;
  } catch {
    return "{}";
  }
}

// The transcript row that marks a switch. It renders as a plain notice in the
// thread and is the boundary the next session builds its handoff from.
function handoffRow(input) {
  const src = input || {};
  const from = String(src.from || "");
  const to = String(src.to || "");
  const fromName = harnessName(from, src.fromName);
  const toName = harnessName(to, src.toName);
  return {
    role: "system",
    kind: HANDOFF_KIND,
    from,
    to,
    fromName,
    toName,
    at: Number.isFinite(src.at) ? src.at : Date.now(),
    text: "Switched from " + fromName + " to " + toName + ". " + toName + " gets the recent messages and tool calls and can read the rest of this chat.",
  };
}

function isHandoffRow(row) {
  return Boolean(row && row.role === "system" && row.kind === HANDOFF_KIND);
}

function latestHandoff(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0; i -= 1) if (isHandoffRow(list[i])) return { row: list[i], index: i };
  return null;
}

// What a tool call did, for the handoff and for jagents_read_chat. Inputs go
// through redaction so cookies and keys never land in the transcript.
function toolDetail(update) {
  const src = update || {};
  const out = {};
  if (src.kind) out.kind = String(src.kind);
  if (src.rawInput != null) {
    const json = redactArgs(src.rawInput);
    if (json && json !== "{}") out.input = clip(json, TOOL_DETAIL_MAX);
  }
  const parts = [];
  for (const item of Array.isArray(src.content) ? src.content : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "content" && item.content && item.content.type === "text" && item.content.text) parts.push(String(item.content.text));
    else if (item.type === "diff" && item.path) parts.push("edited " + item.path);
    else if (item.type === "terminal" && item.terminalId) parts.push("terminal " + item.terminalId);
  }
  if (!parts.length && src.rawOutput != null) {
    const raw = typeof src.rawOutput === "string" ? src.rawOutput : redactArgs(src.rawOutput);
    if (raw && raw !== "{}") parts.push(raw);
  }
  if (parts.length) out.output = clip(parts.join("\n").trim(), TOOL_OUTPUT_MAX);
  // The chat draws these: diff cards, terminal output, file chips.
  const diffs = [];
  const terminals = [];
  for (const item of Array.isArray(src.content) ? src.content : []) {
    if (item && item.type === "diff" && item.path && diffs.length < DIFFS_MAX) {
      diffs.push({ path: String(item.path), oldText: item.oldText == null ? null : clip(String(item.oldText), DIFF_TEXT_MAX), newText: clip(String(item.newText == null ? "" : item.newText), DIFF_TEXT_MAX) });
    } else if (item && item.type === "terminal" && item.terminalId) terminals.push(String(item.terminalId));
  }
  if (diffs.length) out.diffs = diffs;
  if (terminals.length) out.terminals = terminals;
  const paths = (Array.isArray(src.locations) ? src.locations : []).map((l) => l && l.path && String(l.path)).filter(Boolean);
  if (paths.length) out.paths = Array.from(new Set(paths)).slice(0, 20);
  return out;
}

// Rows the agent should see, each labeled with who spoke. Agent rows carry the
// name of whichever agent held the chat at that point.
function labeledRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const first = list.find(isHandoffRow);
  let agent = first ? first.fromName || first.from : "Agent";
  const out = [];
  list.forEach((row, index) => {
    if (!row || typeof row !== "object") return;
    if (isHandoffRow(row)) {
      out.push({ index, row, agent, handoff: true });
      agent = row.toName || row.to || agent;
      return;
    }
    out.push({ index, row, agent });
  });
  return out;
}

function planText(row) {
  return (Array.isArray(row.entries) ? row.entries : [])
    .map((entry) => String((entry && entry.content) || "").trim() + (entry && entry.status ? " (" + entry.status + ")" : ""))
    .filter((line) => line.trim())
    .join("; ");
}

// One row as prompt text, or "" for rows that carry nothing useful (thoughts,
// connection chatter).
function renderRow(entry, max) {
  const { row, agent, index } = entry;
  const tag = "[#" + index + "] ";
  if (entry.handoff) return tag + "[Switched from " + (row.fromName || row.from) + " to " + (row.toName || row.to) + "]";
  const text = String((row && row.text) || "").trim();
  const files = row.role === "user" && row.attachments ? describeAttachments(row.attachments) : "";
  if (row.role === "user" && (text || files)) return tag + "User: " + clip([text, files].filter(Boolean).join("\n"), max);
  if (row.role === "agent" && text) return tag + agent + ": " + clip(text, max);
  if (row.role === "tool") {
    const lines = [tag + agent + " tool call (" + String(row.status || "unknown") + "): " + String(row.title || text || "tool").trim()];
    if (row.input) lines.push("  input: " + clip(row.input, max));
    if (row.output) lines.push("  output: " + clip(row.output, max));
    return lines.join("\n");
  }
  if (row.role === "plan") {
    const plan = planText(row);
    return plan ? tag + agent + " plan: " + clip(plan, max) : "";
  }
  if (row.role === "error" && text) return tag + "JAgents error: " + clip(text, max);
  if (row.role === "system" && /^Stopped|^Turn ended/i.test(text)) return tag + "JAgents: " + clip(text, max);
  return "";
}

// The first-prompt preamble for an agent that just took over a chat. Empty
// unless the newest switch in the rows handed the chat to this agent.
function handoffPrompt(rows, options) {
  const opts = options || {};
  const found = latestHandoff(rows);
  if (!found || String(found.row.to || "") !== String(opts.harnessId || "")) return "";
  const budget = Number.isFinite(opts.budget) ? opts.budget : HANDOFF_BUDGET;
  const rendered = labeledRows(rows)
    .map((entry) => ({ index: entry.index, text: renderRow(entry, HANDOFF_ROW_MAX) }))
    .filter((entry) => entry.text);
  // Newest rows first until the budget runs out, then back to reading order.
  const kept = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const cost = rendered[i].text.length + 1;
    if (kept.length && used + cost > budget) break;
    kept.unshift(rendered[i]);
    used += cost;
  }
  const omitted = rendered.length - kept.length;
  const fromName = found.row.fromName || found.row.from;
  const toName = found.row.toName || found.row.to;
  const chatId = String(opts.chatId || "");
  const read = chatId
    ? "Read older rows, full tool details, or anything cut short with the jagents_read_chat tool (chatId \"" + chatId + "\"; pass before or row with a row number)."
    : "Read older rows or anything cut short with the jagents_read_chat tool.";
  return (
    "Context handoff: the user switched this chat from " + fromName + " to you (" + toName + "). " +
    "You are continuing the same conversation, not starting a new one. Pick up from the latest messages and do not redo finished work unless the user asks.\n" +
    "The prior chat follows, oldest first, with messages, tool calls, and results tagged by row number. " +
    (omitted ? omitted + " older rows are not shown. " : "") +
    read + "\n" +
    "<prior_chat>\n" + kept.map((entry) => entry.text).join("\n") + "\n</prior_chat>"
  );
}

// The whole transcript as handoff text, newest rows kept first within the
// budget, for handoffs that leave the chat (to a terminal agent or a new chat).
function renderTranscript(rows, options) {
  const opts = options || {};
  const budget = Number.isFinite(opts.budget) ? opts.budget : HANDOFF_BUDGET;
  const rendered = labeledRows(rows)
    .map((entry) => renderRow(entry, HANDOFF_ROW_MAX))
    .filter(Boolean);
  const kept = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i -= 1) {
    const cost = rendered[i].length + 1;
    if (kept.length && used + cost > budget) break;
    kept.unshift(rendered[i]);
    used += cost;
  }
  return { text: kept.join("\n"), omitted: rendered.length - kept.length };
}

// Paged read of a chat's transcript for jagents_read_chat. `before` is an
// exclusive row number (newest page when omitted), `row` returns one row in
// full, `query` filters by text.
function readChatRows(record, input) {
  const src = input || {};
  const chat = (record && record.chat) || record;
  if (!chat || !chat.id) throw new Error("Chat not found.");
  const rows = Array.isArray(chat.transcript) ? chat.transcript : [];
  const includeThoughts = Boolean(src.includeThoughts);
  const view = (entry, max) => {
    const { row, agent, index } = entry;
    const out = { row: index, role: entry.handoff ? "handoff" : String(row.role || "") };
    if (row.role === "agent" || row.role === "thought" || row.role === "tool" || row.role === "plan") out.agent = agent;
    const text = row.role === "plan" ? planText(row) : String(row.text || "");
    if (text) out.text = clip(text, max);
    if (row.role === "tool") {
      out.title = String(row.title || "");
      out.status = String(row.status || "");
      if (row.kind) out.kind = String(row.kind);
      if (row.input) out.input = String(row.input);
      if (row.output) out.output = String(row.output);
    }
    if (entry.handoff) Object.assign(out, { from: row.fromName || row.from, to: row.toName || row.to });
    if (Number.isFinite(row.at)) out.at = new Date(row.at).toISOString();
    return out;
  };
  let entries = labeledRows(rows).filter((entry) => includeThoughts || entry.row.role !== "thought");
  const base = { chatId: String(chat.id || ""), title: String(chat.title || ""), harnessId: String(chat.harnessId || ""), total: rows.length };
  if (src.row != null && src.row !== "") {
    const at = Number(src.row);
    const hit = entries.find((entry) => entry.index === at);
    if (!hit) throw new Error("Row " + src.row + " is not in this chat.");
    return Object.assign(base, { rows: [view(hit, READ_FULL_MAX)] });
  }
  const query = String(src.query || "").trim().toLowerCase();
  if (query) {
    entries = entries.filter((entry) => {
      const row = entry.row;
      return [row.text, row.title, row.input, row.output, planText(row)].some((value) => String(value || "").toLowerCase().includes(query));
    });
  }
  const before = src.before != null && src.before !== "" && Number.isFinite(Number(src.before)) ? Number(src.before) : Infinity;
  const limit = Math.max(1, Math.min(READ_LIMIT_MAX, Math.floor(Number(src.limit) || READ_LIMIT_DEFAULT)));
  const eligible = entries.filter((entry) => entry.index < before);
  const page = eligible.slice(-limit);
  const out = Object.assign(base, { rows: page.map((entry) => view(entry, READ_ROW_MAX)) });
  if (eligible.length > page.length && page.length) out.before = page[0].index;
  return out;
}

module.exports = {
  HANDOFF_KIND,
  HANDOFF_BUDGET,
  handoffRow,
  isHandoffRow,
  latestHandoff,
  toolDetail,
  handoffPrompt,
  renderTranscript,
  readChatRows,
};
