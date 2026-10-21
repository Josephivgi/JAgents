// Tool rows in a chat: a label per tool kind (Read, Edited, Ran, Searched)
// with file chips, diff cards for edits, output blocks for commands, groups
// for runs of the same kind ("Edited 3 files"), and the per-turn rollup of
// changed files.

import { esc } from "./util.js";
import { icon } from "./icons.js";

const KINDS = {
  read: { verb: "Read", past: "Read", icon: "file", noun: "file" },
  edit: { verb: "Edit", past: "Edited", icon: "pencil", noun: "file" },
  delete: { verb: "Delete", past: "Deleted", icon: "trash", noun: "file" },
  move: { verb: "Move", past: "Moved", icon: "file", noun: "file" },
  search: { verb: "Search", past: "Searched", icon: "search", noun: "search" },
  execute: { verb: "Run", past: "Ran", icon: "terminal", noun: "command" },
  fetch: { verb: "Fetch", past: "Fetched", icon: "globe", noun: "page" },
  think: { verb: "Think", past: "Thought", icon: "subagent", noun: "step" },
};

// Kinds whose runs collapse into one group row.
const GROUPABLE = new Set(["read", "edit", "search", "fetch"]);

export function baseName(p) {
  return String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
}

function parseInput(row) {
  if (!row.input) return null;
  try {
    return JSON.parse(row.input);
  } catch {
    return null;
  }
}

export function rowPaths(row) {
  const out = [];
  for (const p of row.paths || []) out.push(p);
  for (const d of row.diffs || []) out.push(d.path);
  return Array.from(new Set(out.filter(Boolean)));
}

function commandOf(row) {
  const input = parseInput(row);
  if (input && typeof input.command === "string") return input.command;
  if (input && Array.isArray(input.command)) return input.command.join(" ");
  return "";
}

// "Ran npm test" from a title like "Run npm test" or "`npm test`".
function titleRest(row, kind) {
  let t = String(row.title || "").trim();
  const k = KINDS[kind];
  if (k) {
    for (const w of [k.verb, k.past, k.verb + "ning", k.verb + "ing"]) {
      if (t.toLowerCase().startsWith(w.toLowerCase() + " ")) {
        t = t.slice(w.length + 1);
        break;
      }
    }
  }
  return t.replace(/^`(.*)`$/, "$1");
}

export function fileChip(p) {
  return '<button type="button" class="file-chip" data-open-file="' + esc(p) + '" title="' + esc(p) + '">' + icon("file", 12) + "<span>" + esc(baseName(p)) + "</span></button>";
}

export function toolStatusIcon(st) {
  return st === "completed" ? icon("check", 14) : st === "failed" || st === "cancelled" ? icon("close", 14) : '<span class="spinner sm"></span>';
}

// The summary line: verb, then file chips or the rest of the title.
export function toolLabel(row) {
  const kind = String(row.kind || "").toLowerCase();
  const k = KINDS[kind];
  const st = row.status || "pending";
  const done = st === "completed";
  const verb = k ? (done ? k.past : st === "failed" ? k.verb + " failed" : k.verb) : "";
  const paths = rowPaths(row);
  let rest;
  if (kind === "execute") rest = '<code class="tool-cmd">' + esc(commandOf(row) || titleRest(row, kind)) + "</code>";
  else if (paths.length && kind !== "search" && kind !== "fetch") rest = '<span class="file-chips">' + paths.slice(0, 4).map(fileChip).join("") + (paths.length > 4 ? '<span class="muted small">+' + (paths.length - 4) + "</span>" : "") + "</span>";
  else rest = '<span class="tool-title">' + esc(k ? titleRest(row, kind) : row.title) + "</span>";
  return (verb ? '<span class="tool-verb">' + esc(verb) + "</span>" : "") + rest;
}

// ---- Diffs ----------------------------------------------------------------

const DIFF_CELLS = 2000000;

// Line diff (LCS). Very large pairs fall back to all-removed then all-added.
export function lineDiff(oldText, newText) {
  const a = oldText == null || oldText === "" ? [] : String(oldText).split("\n");
  const b = String(newText == null ? "" : newText).split("\n");
  if (!a.length) return b.map((t) => ({ t, op: "+" }));
  if (a.length * b.length > DIFF_CELLS) return a.map((t) => ({ t, op: "-" })).concat(b.map((t) => ({ t, op: "+" })));
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ t: a[i], op: " " });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: a[i++], op: "-" });
    else out.push({ t: b[j++], op: "+" });
  }
  while (i < n) out.push({ t: a[i++], op: "-" });
  while (j < m) out.push({ t: b[j++], op: "+" });
  return out;
}

export function diffStats(diff) {
  const lines = lineDiff(diff.oldText, diff.newText);
  let add = 0;
  let del = 0;
  for (const l of lines) {
    if (l.op === "+") add++;
    else if (l.op === "-") del++;
  }
  return { lines, add, del };
}

// Unchanged runs longer than this fold to their edges.
const CONTEXT = 3;

export function diffCard(diff) {
  const { lines, add, del } = diffStats(diff);
  const body = [];
  let run = [];
  const flush = (last) => {
    if (run.length > CONTEXT * 2 + 1) {
      const head = body.length ? run.slice(0, CONTEXT) : [];
      const tail = last ? [] : run.slice(-CONTEXT);
      for (const l of head) body.push(l);
      body.push({ op: "~", t: run.length - head.length - tail.length + " unchanged lines" });
      for (const l of tail) body.push(l);
    } else for (const l of run) body.push(l);
    run = [];
  };
  for (const l of lines) {
    if (l.op === " ") run.push(l);
    else {
      flush(false);
      body.push(l);
    }
  }
  flush(true);
  const rows = body
    .slice(0, 400)
    .map((l) => (l.op === "~" ? '<div class="dl fold">' + esc(l.t) + "</div>" : '<div class="dl ' + (l.op === "+" ? "add" : l.op === "-" ? "del" : "ctx") + '"><span class="dm">' + esc(l.op) + "</span>" + esc(l.t) + "</div>"))
    .join("");
  return (
    '<div class="diff-card"><div class="diff-head">' + fileChip(diff.path) + '<span class="diff-path muted small" title="' + esc(diff.path) + '">' + esc(diff.path) + "</span>" +
    (diff.oldText == null ? '<span class="diff-new">New</span>' : "") +
    '<span class="diff-stat"><span class="add">+' + add + '</span> <span class="del">−' + del + "</span></span></div>" +
    '<div class="diff-body">' + rows + (body.length > 400 ? '<div class="dl fold">' + (body.length - 400) + " more lines</div>" : "") + "</div></div>"
  );
}

// ---- Tool body ------------------------------------------------------------

export function toolBody(row) {
  const parts = [];
  const kind = String(row.kind || "").toLowerCase();
  for (const d of row.diffs || []) parts.push(diffCard(d));
  const term = row.terminalOutput || (kind === "execute" ? row.output : "");
  if (kind === "execute" || row.terminalOutput) {
    const cmd = commandOf(row);
    parts.push(
      '<div class="term-block">' + (cmd ? '<div class="term-cmd"><span class="dm">$</span>' + esc(cmd) + "</div>" : "") +
      (term ? '<pre class="term-out">' + esc(term) + "</pre>" : "") +
      (row.exitCode != null && row.exitCode !== 0 ? '<div class="term-exit">Exit code ' + esc(row.exitCode) + "</div>" : "") + "</div>",
    );
  }
  const showInput = row.input && !(row.diffs && row.diffs.length) && kind !== "execute";
  if (showInput) {
    const parsed = parseInput(row);
    parts.push('<div class="tool-io"><span>Input</span><pre>' + esc(parsed ? JSON.stringify(parsed, null, 2) : row.input) + "</pre></div>");
  }
  // A finished edit's diff says it all; its "file updated" text is noise.
  const editDone = row.diffs && row.diffs.length && row.status === "completed";
  const showOutput = row.output && !editDone && kind !== "execute" && !row.terminalOutput && !/^(edited |terminal )/.test(row.output);
  if (showOutput) parts.push('<div class="tool-io"><span>Output</span><pre>' + esc(row.output) + "</pre></div>");
  return parts.join("");
}

// ---- Groups and rollups ---------------------------------------------------

export function groupable(row) {
  return row && row.role === "tool" && row.status === "completed" && GROUPABLE.has(String(row.kind || "").toLowerCase());
}

export function groupLabel(rows) {
  const kind = String(rows[0].kind || "").toLowerCase();
  const k = KINDS[kind];
  const files = new Set(rows.flatMap(rowPaths));
  if ((kind === "read" || kind === "edit") && files.size) return k.past + " " + files.size + " file" + (files.size === 1 ? "" : "s");
  if (kind === "search") return "Searched " + rows.length + " times";
  return k.past + " " + rows.length + " " + k.noun + "s";
}

export function groupIcon(rows) {
  const k = KINDS[String(rows[0].kind || "").toLowerCase()];
  return icon(k ? k.icon : "wand", 14);
}

// Files changed across a turn, each with its added and removed line counts.
export function turnRollup(rows) {
  const files = new Map();
  for (const r of rows) {
    if (r.role !== "tool" || r.status !== "completed") continue;
    for (const d of r.diffs || []) {
      const s = diffStats(d);
      const f = files.get(d.path) || { path: d.path, add: 0, del: 0 };
      f.add += s.add;
      f.del += s.del;
      files.set(d.path, f);
    }
  }
  if (!files.size) return "";
  const list = Array.from(files.values());
  const add = list.reduce((n, f) => n + f.add, 0);
  const del = list.reduce((n, f) => n + f.del, 0);
  return (
    '<div class="turn-diff"><div class="turn-diff-head">' + icon("pencil", 13) + "<span>Changed " + list.length + " file" + (list.length === 1 ? "" : "s") + '</span><span class="diff-stat"><span class="add">+' + add + '</span> <span class="del">−' + del + "</span></span></div>" +
    '<div class="turn-diff-files">' + list.map((f) => '<div class="turn-diff-file">' + fileChip(f.path) + '<span class="muted small grow" title="' + esc(f.path) + '">' + esc(f.path) + '</span><span class="diff-stat"><span class="add">+' + f.add + '</span> <span class="del">−' + f.del + "</span></span></div>").join("") + "</div></div>"
  );
}
