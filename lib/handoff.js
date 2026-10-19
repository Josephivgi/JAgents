"use strict";

// Context handoffs that cross agents or pane kinds: terminal -> chat,
// chat -> terminal, terminal -> terminal, chat -> new chat. The source's recent
// context becomes a markdown file under <dataRoot>/handoffs, and the target is
// told to read it. In-thread switches (picking another agent in a chat's
// composer) use acp-handoff.js directly, the way Plugin App does.

const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { renderTranscript } = require("./acp-handoff");

const TERMINAL_BUDGET = 24000;

// Terminal scrollback is TUI output: collapse runs of blank lines and drop
// box-drawing-only lines so the text is mostly what was said and done.
function cleanTerminalText(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const out = [];
  let blank = 0;
  for (const line of lines) {
    if (/^[\s─━│┃┌┐└┘├┤┬┴┼╭╮╯╰═║╔╗╚╝▔▁▏▕]*$/.test(line)) {
      if (++blank > 1) continue;
      out.push("");
      continue;
    }
    blank = 0;
    out.push(line);
  }
  return out.join("\n").trim();
}

function tail(text, budget) {
  const value = String(text || "");
  if (value.length <= budget) return { text: value, cut: 0 };
  const sliced = value.slice(-budget);
  const nl = sliced.indexOf("\n");
  const kept = nl >= 0 && nl < 400 ? sliced.slice(nl + 1) : sliced;
  return { text: kept, cut: value.length - kept.length };
}

// source: { handle, name, kind: "terminal"|"chat", provider, cwd, id, text?, rows? }
function buildHandoff(source, options) {
  const opts = options || {};
  const note = String(opts.note || "").trim();
  const lines = [];
  lines.push("# Context handoff from " + source.handle + " (" + source.name + ")");
  lines.push("");
  lines.push("- From: " + source.handle + ", a " + source.kind + " agent (" + source.provider + ")");
  if (source.cwd) lines.push("- Working folder: " + source.cwd);
  lines.push("- Handed off: " + new Date().toISOString());
  if (opts.toHandle) lines.push("- To: " + opts.toHandle);
  lines.push("");
  if (note) {
    lines.push("## What to do next");
    lines.push("");
    lines.push(note);
    lines.push("");
  }
  if (source.kind === "chat") {
    const rendered = renderTranscript(source.rows || [], { budget: TERMINAL_BUDGET });
    lines.push("## Prior conversation (oldest first)");
    lines.push("");
    if (rendered.omitted) lines.push("_" + rendered.omitted + " older rows are not shown. Read them with the relay read_agent tool (agent \"" + source.handle + "\")._\n");
    lines.push("```text");
    lines.push(rendered.text || "(empty)");
    lines.push("```");
  } else {
    const cleaned = tail(cleanTerminalText(source.text), TERMINAL_BUDGET);
    lines.push("## Recent terminal session (" + source.provider + ")");
    lines.push("");
    if (cleaned.cut) lines.push("_" + cleaned.cut + " earlier characters are not shown. Read more with the relay read_agent tool (agent \"" + source.handle + "\")._\n");
    lines.push("```text");
    lines.push(cleaned.text || "(empty)");
    lines.push("```");
  }
  lines.push("");
  lines.push("You are continuing this work, not starting over. Do not redo finished work unless asked.");
  return lines.join("\n");
}

function writeHandoffFile(dataRoot, markdown) {
  const dir = path.join(dataRoot, "handoffs");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, stamp + "-" + randomUUID().slice(0, 8) + ".md");
  fs.writeFileSync(file, markdown);
  return file;
}

// The short instruction a target receives. Kept to one line so it can be typed
// into a terminal agent's prompt or passed as a CLI argument.
function handoffInstruction(source, file, note) {
  const ask = String(note || "").trim();
  return (
    "Context handoff from " + source.handle + " (" + source.name + "): read " + file + " for what happened so far. " +
    (ask ? "Then: " + ask.replace(/\s+/g, " ") : "Then summarize where things stand in two lines and wait for my next instruction.")
  );
}

module.exports = { buildHandoff, writeHandoffFile, handoffInstruction, cleanTerminalText };
