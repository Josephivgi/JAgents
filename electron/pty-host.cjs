"use strict";

// Real terminals for the terminal panes: node-pty (ConPTY on Windows) runs the
// agent CLI, and a headless xterm mirrors the screen so the MCP hub and context
// handoffs can read clean text from a TUI (Claude Code and Codex redraw
// constantly, so the raw byte stream is not readable on its own).
//
// The same host runs in two places. In the pty daemon (pty-daemon.cjs) it
// spawns node-pty processes. In the app it gets `spawn` from pty-client.cjs,
// whose processes are proxies for the daemon's, so terminals outlive an app
// restart and the app keeps its own mirror for synchronous reads.

const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");
const { Unicode11Addon } = require("@xterm/addon-unicode11");

const SCROLLBACK = 8000;
const FLUSH_MS = 12;
const BUSY_WINDOW_MS = 1500;
const WINDOWS_PTY = process.platform === "win32" ? { backend: "conpty", buildNumber: Number(require("node:os").release().split(".")[2]) || undefined } : undefined;

function nodePtySpawn(opts) {
  const pty = require("node-pty");
  return pty.spawn(opts.command, opts.args || [], {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: Object.assign({}, process.env, { TERM: "xterm-256color", COLORTERM: "truecolor" }, opts.env || {}),
    useConpty: true,
  });
}

function createPtyHost({ emit, spawn }) {
  const terms = new Map();
  const spawnProc = spawn || nodePtySpawn;

  function flush(t) {
    clearTimeout(t.flushTimer);
    t.flushTimer = null;
    if (!t.pending) return;
    const data = t.pending;
    t.pending = "";
    emit("pty-data", { id: t.id, data });
  }

  // Output goes out only after the mirror has parsed it, so a snapshot taken
  // at any point holds exactly what was already sent and nothing is drawn twice.
  function track(id, proc, cols, rows, seed) {
    // Same character widths and resize behavior as the panes' xterm, so the
    // snapshot a pane redraws from lines up with what the agent drew.
    const mirror = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true, windowsPty: WINDOWS_PTY });
    const serializer = new SerializeAddon();
    mirror.loadAddon(serializer);
    mirror.loadAddon(new Unicode11Addon());
    mirror.unicode.activeVersion = "11";
    const t = { id, proc, mirror, serializer, pending: "", flushTimer: null, lastOutputAt: 0, startedAt: Date.now(), exited: false, exitCode: null, listeners: new Set() };
    terms.set(id, t);
    const ready = seed ? new Promise((r) => mirror.write(seed, r)) : Promise.resolve();
    // A killed terminal's late output or exit must not reach a new one with the same id.
    const live = () => terms.get(id) === t;
    proc.onData((data) => {
      if (!live()) return;
      t.lastOutputAt = Date.now();
      mirror.write(data, () => {
        if (!live()) return;
        t.pending += data;
        if (!t.flushTimer) t.flushTimer = setTimeout(() => flush(t), FLUSH_MS);
        for (const fn of t.listeners) fn(data);
      });
    });
    proc.onExit(({ exitCode }) => {
      if (!live()) return;
      mirror.write("", () => {
        flush(t);
        t.exited = true;
        t.exitCode = exitCode;
        emit("pty-exit", { id, exitCode });
      });
    });
    return { t, ready };
  }

  function create(opts) {
    const { id, cols, rows } = opts;
    if (terms.has(id)) throw new Error("Terminal " + id + " already exists.");
    const c = Math.max(20, cols || 100);
    const r = Math.max(5, rows || 30);
    const proc = spawnProc(Object.assign({}, opts, { cols: c, rows: r }));
    track(id, proc, c, r);
    return { id, pid: proc.pid };
  }

  // A terminal that is already running elsewhere (the daemon, after an app
  // restart): its serialized screen seeds the mirror. Resolves once parsed.
  function adopt(snap, proc) {
    if (terms.has(snap.id)) return Promise.resolve();
    const { t, ready } = track(snap.id, proc, Math.max(20, snap.cols || 100), Math.max(5, snap.rows || 30), snap.data || "");
    if (snap.exited) {
      t.exited = true;
      t.exitCode = snap.exitCode;
    }
    return ready;
  }

  // Sends whatever has been parsed but not sent yet.
  function flushAll() {
    for (const t of terms.values()) flush(t);
  }

  function get(id) {
    const t = terms.get(id);
    if (!t) throw new Error("No terminal " + id + ".");
    return t;
  }

  function write(id, data) {
    const t = terms.get(id);
    if (t && !t.exited) t.proc.write(String(data));
  }

  function resize(id, cols, rows) {
    const t = terms.get(id);
    if (!t || t.exited) return;
    const c = Math.max(20, Math.floor(cols));
    const r = Math.max(5, Math.floor(rows));
    try {
      t.proc.resize(c, r);
      t.mirror.resize(c, r);
    } catch {
      /* the process went away mid-resize */
    }
  }

  // A selection menu on screen (Codex's update prompt, a trust or permission
  // dialog): typing a message and pressing Enter would pick the highlighted
  // option, so messages wait for a person to answer it. Returns the menu line.
  const MENU_LINE = /^\s*[›❯>]\s*\d+\.\s+\S/;
  const MENU_HINT = /press enter to (continue|confirm)|do you want to|do you trust|enter to select|esc to (cancel|go back)/i;
  function blockingMenu(id) {
    const t = terms.get(id);
    if (!t || t.exited) return null;
    const buf = t.mirror.buffer.active;
    const lines = [];
    for (let i = buf.baseY; i < buf.baseY + t.mirror.rows; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    const picked = lines.find((l) => MENU_LINE.test(l));
    return picked && lines.some((l) => MENU_HINT.test(l)) ? picked.trim() : null;
  }

  // Types a message into an agent's prompt the way a person pastes it, then
  // presses Enter. Bracketed paste keeps multi-line text in one prompt.
  async function sendInput(id, text) {
    const t = get(id);
    if (t.exited) throw new Error("That terminal has exited.");
    const menu = blockingMenu(id);
    if (menu) throw new Error('That terminal is showing a menu ("' + menu.slice(0, 80) + '"), so nothing was typed. Ask the user to answer it in JAgents, then try again.');
    const body = String(text).replace(/\r\n/g, "\n");
    t.proc.write("\x1b[200~" + body + "\x1b[201~");
    await new Promise((r) => setTimeout(r, 180));
    t.proc.write("\r");
  }

  // Screen text from the mirror: scrollback plus the visible screen, trailing
  // blank lines dropped. Lines are the last `max` lines.
  function text(id, max) {
    const t = get(id);
    const buf = t.mirror.buffer.active;
    const out = [];
    let prevFull = false;
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      // A soft wrap only when the row above runs to the last column; TUIs pad
      // rows with real spaces, which marks the next row wrapped too.
      if (line.isWrapped && out.length && prevFull) out[out.length - 1] += line.translateToString(true);
      else out.push(line.translateToString(true));
      prevFull = !/\s$/.test(line.translateToString(false));
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    const n = Math.max(1, Math.min(SCROLLBACK, Number(max) || 200));
    return out
      .slice(-n)
      .map((l) => l.replace(/\s+$/, ""))
      .join("\n");
  }

  // The renderer reattaches to a running terminal (window reload) by writing
  // the serialized screen first.
  function snapshot(id) {
    const t = terms.get(id);
    if (!t) return null;
    return { id, data: t.serializer.serialize({ scrollback: 2000 }), exited: t.exited, exitCode: t.exitCode, cols: t.mirror.cols, rows: t.mirror.rows, pid: t.proc.pid };
  }

  function status(id) {
    const t = terms.get(id);
    if (!t) return "gone";
    if (t.exited) return "exited";
    return Date.now() - t.lastOutputAt < BUSY_WINDOW_MS ? "busy" : "idle";
  }

  // Resolves once output has been quiet for quietMs (the agent finished
  // printing), or when timeoutMs passes.
  function waitIdle(id, quietMs, timeoutMs) {
    const t = get(id);
    const quiet = quietMs || 4000;
    const deadline = Date.now() + (timeoutMs || 60000);
    return new Promise((resolve) => {
      const tick = () => {
        if (t.exited) return resolve("exited");
        if (Date.now() - t.lastOutputAt >= quiet) return resolve("idle");
        if (Date.now() >= deadline) return resolve("timeout");
        setTimeout(tick, 300);
      };
      setTimeout(tick, 300);
    });
  }

  function pid(id) {
    const t = terms.get(id);
    return t ? t.proc.pid : 0;
  }

  function kill(id) {
    const t = terms.get(id);
    if (!t) return;
    terms.delete(id);
    clearTimeout(t.flushTimer);
    try {
      if (!t.exited) t.proc.kill();
      // An exited terminal still has an entry in the pty daemon; without
      // this, Restart failed there with "Terminal ... already exists".
      else if (t.proc.forget) t.proc.forget();
    } catch {
      /* already gone */
    }
    t.mirror.dispose();
  }

  function killAll() {
    for (const id of Array.from(terms.keys())) kill(id);
  }

  return { create, adopt, flushAll, write, resize, sendInput, blockingMenu, text, snapshot, status, waitIdle, pid, kill, killAll, has: (id) => terms.has(id), ids: () => Array.from(terms.keys()), pids: () => Array.from(terms.values()).map((t) => ({ id: t.id, pid: t.proc.pid })) };
}

module.exports = { createPtyHost };
