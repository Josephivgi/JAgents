function idFrom(obj) {
  if (!obj || typeof obj !== "object") return "";
  if (obj.terminalId) return String(obj.terminalId);
  if (obj.terminal_id) return String(obj.terminal_id);
  const nested = obj.terminal;
  if (nested && typeof nested === "object") {
    if (nested.terminalId) return String(nested.terminalId);
    if (nested.terminal_id) return String(nested.terminal_id);
    if (nested.id) return String(nested.id);
  }
  return "";
}

function commandLine(obj) {
  if (!obj || typeof obj !== "object") return "";
  const src = obj.command ? obj : obj.terminal && typeof obj.terminal === "object" ? obj.terminal : null;
  if (!src || !src.command) return "";
  const args = Array.isArray(src.args) ? src.args : [];
  return [src.command].concat(args).join(" ");
}

function chunkText(obj) {
  if (!obj || typeof obj !== "object") return "";
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.chunk === "string") return obj.chunk;
  if (typeof obj.data === "string") return obj.data;
  if (obj.content && typeof obj.content === "object" && !Array.isArray(obj.content)) {
    return chunkText(obj.content);
  }
  if (typeof obj.content === "string") return obj.content;
  return "";
}

function snapshotText(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.output === "string") return obj.output;
  if (obj.output && typeof obj.output === "object") {
    if (typeof obj.output.text === "string") return obj.output.text;
    if (typeof obj.output.data === "string") return obj.output.data;
    if (typeof obj.output.output === "string") return obj.output.output;
  }
  if (obj.terminal && typeof obj.terminal === "object" && obj.terminal !== obj) {
    const nested = snapshotText(obj.terminal);
    if (nested != null) return nested;
  }
  return null;
}

function isTerminalUpdate(obj) {
  if (!obj || typeof obj !== "object") return false;
  const kind = obj.sessionUpdate || obj.session_update || "";
  if (kind === "terminal_update" || kind === "terminal_output_chunk") return true;
  if (obj.type === "terminal") return true;
  if (idFrom(obj)) return true;
  if (obj.terminal && typeof obj.terminal === "object") return true;
  if (snapshotText(obj) != null) return true;
  return false;
}

// Kept per-terminal text, same bound the client uses on real processes; an
// agent streaming terminal chunks must not grow memory without bound.
const OUTPUT_MAX = 256 * 1024;

function createTerminalHub() {
  const byId = new Map();
  let seq = 0;

  function row(id) {
    const key = String(id || "default");
    let item = byId.get(key);
    if (!item) {
      item = { id: key, output: "", truncated: false };
      byId.set(key, item);
    }
    return item;
  }

  function allocate(preferred) {
    const id = String(preferred || "").trim() || "relay-term-" + String(++seq);
    row(id);
    return id;
  }

  function ingest(obj) {
    if (!obj || typeof obj !== "object") return false;
    const item = row(idFrom(obj) || "default");
    if (obj.truncated === true) item.truncated = true;
    const replaced = snapshotText(obj);
    if (replaced != null) {
      if (replaced.length > OUTPUT_MAX) item.truncated = true;
      item.output = replaced.slice(-OUTPUT_MAX);
      return true;
    }
    const extra = chunkText(obj);
    if (extra) {
      const next = item.output + extra;
      if (next.length > OUTPUT_MAX) item.truncated = true;
      item.output = next.slice(-OUTPUT_MAX);
      return true;
    }
    const cmd = commandLine(obj);
    if (cmd && !item.output) item.output = cmd;
    return true;
  }

  function ingestSession(params) {
    const p = params || {};
    const nodes = [p];
    if (p.update && typeof p.update === "object") nodes.push(p.update);
    let recorded = false;
    for (const node of nodes) {
      if (isTerminalUpdate(node)) recorded = ingest(node) || recorded;
      const nested = node.terminal;
      if (nested && typeof nested === "object") recorded = ingest(nested) || recorded;
      const content = node.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "terminal" || idFrom(part) || (part.terminal && typeof part.terminal === "object")) {
          recorded = ingest(part) || recorded;
        }
      }
    }
    return recorded;
  }

  function handle(method, params) {
    const name = String(method || "");
    const p = params || {};
    if (name === "terminal/create") {
      const id = allocate(idFrom(p));
      ingest(Object.assign({}, p, { terminalId: id }));
      return id;
    }
    if (name === "terminal/output") return ingest(p);
    if (name === "session/update") return ingestSession(p);
    return false;
  }

  function snapshot() {
    return Array.from(byId.values()).map((item) => ({
      id: item.id,
      output: item.output,
      truncated: item.truncated,
    }));
  }

  function clear() {
    byId.clear();
  }

  return { handle, snapshot, clear, allocate, row, has: (id) => byId.has(String(id || "")) };
}

module.exports = { createTerminalHub };
