"use strict";

// The jagents screen: tabs, the sidebar, panes, cards, keys and the mouse.
// jagents.cjs (the host) owns the real terminal and the running programs.
// When this file or one it loads changes, the host loads the new copy and
// calls stop() on this one, then start() on the new one with the same tabs:
// programs keep running, only the code that draws and reads keys is new.

const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const APP_ROOT = path.join(__dirname, "..");
const pkg = require(path.join(APP_ROOT, "package.json"));
const { listTerminalAgents, terminalSpawnSpec } = require(path.join(APP_ROOT, "lib", "agents"));
const desk = require("./desktop.cjs");

const PREFIX = "\x02"; // Ctrl+B, as in tmux
const ESC = "\x1b";
const CSI = ESC + "[";

// Set by start(): the host, and node-pty and xterm as the host loaded them.
let host = null;
let pty = null;
let Terminal = null;
let stopped = false;

// ---- state ----------------------------------------------------------------

const out = process.stdout;
const cwd = process.cwd();
let tabs = []; // {root, focus}; every pane has its own name
const SIDE = 28; // sidebar width
let sidebar = true;
let active = -1;
let overlay = null; // {kind:"picker"|"name"|"help"|"confirm", ...}
let prefixOn = false;
let note = null; // {text, tone}
let noteTimer = null;
let seq = 0;
let hits = []; // clickable ranges drawn this frame {x0, x1, y, run}
let mouse = { x: -1, y: -1 };
let quitting = false;

// ---- panes and layout -----------------------------------------------------

function newPane(agent, cols, rows, name, folder = cwd) {
  const base = terminalSpawnSpec(agent.id);
  const paneId = ++seq;
  const spec = host.runtime ? host.runtime.paneSpec(agent.id, base, paneId) : base;
  const term = new Terminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
  const pane = { kind: "pane", id: paneId, agent, cwd: folder, name: name || defaultName(agent), term, proc: null, rect: { x: 0, y: 1, w: cols, h: rows }, exited: null };
  try {
    pane.proc = pty.spawn(spec.command, spec.args, { name: "xterm-256color", cols, rows, cwd: folder, env: Object.assign({}, process.env, spec.env || {}) });
  } catch (error) { term.dispose(); throw error; }
  wire(pane);
  return pane;
}

// The pane's listeners belong to this copy of the code, so stop() drops them
// and the next copy wires its own.
function wire(pane) {
  const { term, agent } = pane;
  pane.subs = [
    pane.proc.onData((d) => {
      term.write(d);
      host.runtime?.emit("terminal-data", { id: pane.id, data: d });
      schedule();
    }),
    pane.proc.onExit(({ exitCode }) => {
      pane.exited = exitCode;
      host.runtime?.emit("terminal-exit", { id: pane.id, exitCode });
      term.write("\r\n\x1b[2m[" + agent.name + " exited" + (exitCode ? " with code " + exitCode : "") + ". Press Enter to close.]\x1b[0m");
      schedule();
    }),
    // Answers to the program's terminal queries (cursor position and the like).
    term.onData((d) => {
      if (pane.exited === null) pane.proc.write(d);
    }),
  ];
}

function unwire(pane) {
  for (const s of pane.subs || []) {
    try {
      s.dispose();
    } catch {
      /* already gone */
    }
  }
  pane.subs = [];
}

function allPanes() {
  return tabs.flatMap((t) => panesOf(t.root));
}

// "Claude Code", then "Claude Code 2", "Claude Code 3"...
function defaultName(agent) {
  const taken = new Set(allPanes().map((p) => p.name));
  if (!taken.has(agent.name)) return agent.name;
  let n = 2;
  while (taken.has(agent.name + " " + n)) n++;
  return agent.name + " " + n;
}

function panesOf(node) {
  if (!node) return [];
  return node.kind === "pane" ? [node] : panesOf(node.a).concat(panesOf(node.b));
}

function tab() {
  return tabs[active] || null;
}

// The sidebar hides itself when the window is too narrow for it.
function sideWidth() {
  return sidebar && (out.columns || 80) >= SIDE + 40 ? SIDE : 0;
}

// Row 0 is the tab bar, the last row the status line.
function contentRect() {
  const s = sideWidth();
  const x = s ? s + 1 : 0;
  return { x, y: 1, w: Math.max(1, (out.columns || 80) - x), h: Math.max(1, (out.rows || 24) - 2) };
}

let seps = []; // separator cells {x, y, ch}
function layout(node, r) {
  if (node.kind === "pane") {
    node.rect = r;
    const w = Math.max(1, r.w);
    const h = Math.max(1, r.h);
    if (node.term.cols !== w || node.term.rows !== h) {
      node.term.resize(w, h);
      if (node.exited === null) {
        try {
          node.proc.resize(w, h);
        } catch {
          /* already gone */
        }
      }
    }
    return;
  }
  if (node.dir === "row") {
    const lw = Math.max(1, Math.floor((r.w - 1) / 2));
    layout(node.a, { x: r.x, y: r.y, w: lw, h: r.h });
    for (let y = r.y; y < r.y + r.h; y++) seps.push({ x: r.x + lw, y, ch: "│" });
    layout(node.b, { x: r.x + lw + 1, y: r.y, w: Math.max(1, r.w - lw - 1), h: r.h });
  } else {
    const th = Math.max(1, Math.floor((r.h - 1) / 2));
    layout(node.a, { x: r.x, y: r.y, w: r.w, h: th });
    for (let x = r.x; x < r.x + r.w; x++) seps.push({ x, y: r.y + th, ch: "─" });
    layout(node.b, { x: r.x, y: r.y + th + 1, w: r.w, h: Math.max(1, r.h - th - 1) });
  }
}

function relayout() {
  seps = [];
  const t = tab();
  if (t) layout(t.root, contentRect());
}

function addTab(agent, name, folder) {
  const r = contentRect();
  const pane = newPane(agent, r.w, r.h, name, folder);
  tabs.push({ root: pane, focus: pane });
  active = tabs.length - 1;
  relayout();
  host.runtime?.emit("terminal-opened", paneInfo(pane));
  return pane;
}

function split(agent, dir, name, folder) {
  const t = tab();
  if (!t) return addTab(agent, name, folder);
  const old = t.focus;
  const pane = newPane(agent, Math.max(1, Math.floor(old.rect.w / 2)), Math.max(1, Math.floor(old.rect.h / 2)), name, folder);
  const node = { kind: "split", dir, a: old, b: pane };
  t.root = replace(t.root, old, node);
  t.focus = pane;
  relayout();
  host.runtime?.emit("terminal-opened", paneInfo(pane));
  return pane;
}

function replace(node, from, to) {
  if (node === from) return to;
  if (node.kind === "split") {
    node.a = replace(node.a, from, to);
    node.b = replace(node.b, from, to);
  }
  return node;
}

function remove(node, target) {
  if (node === target) return null;
  if (node.kind !== "split") return node;
  const a = remove(node.a, target);
  const b = remove(node.b, target);
  if (!a) return b;
  if (!b) return a;
  node.a = a;
  node.b = b;
  return node;
}

function closePane(pane) {
  const i = tabs.findIndex((t) => panesOf(t.root).includes(pane));
  if (i < 0) return;
  unwire(pane);
  if (pane.exited === null) {
    try {
      pane.proc.kill();
    } catch {
      /* gone */
    }
  }
  pane.term.dispose();
  const t = tabs[i];
  t.root = remove(t.root, pane);
  if (!t.root) {
    tabs.splice(i, 1);
    if (active >= tabs.length) active = tabs.length - 1;
  } else if (t.focus === pane) t.focus = panesOf(t.root)[0];
  relayout();
  host.runtime?.emit("terminal-closed", { id: pane.id });
  if (!tabs.length) openPicker("tab", true);
  schedule();
}

function closeTab(i) {
  const t = tabs[i];
  if (!t) return;
  for (const p of panesOf(t.root)) closePane(p);
}

function selectTab(i) {
  if (i < 0 || i >= tabs.length) return;
  active = i;
  relayout();
  schedule();
}

function focusPane(pane) {
  const i = tabs.findIndex((t) => panesOf(t.root).includes(pane));
  if (i < 0) return;
  tabs[i].focus = pane;
  selectTab(i);
}

function cyclePane(step) {
  const t = tab();
  if (!t) return;
  const list = panesOf(t.root);
  const i = list.indexOf(t.focus);
  t.focus = list[(i + step + list.length) % list.length];
  schedule();
}

// ---- actions --------------------------------------------------------------

function openPicker(mode, required) {
  const items = listTerminalAgents()
    .filter((a) => a.available)
    .map((a) => ({ label: a.name, hint: a.id, agent: a }));
  overlay = { kind: "picker", mode, all: items, query: "", index: 0, required: Boolean(required) };
  schedule();
}

function pickerItems(o) {
  const q = o.query.toLowerCase();
  const list = q ? o.all.filter((it) => it.label.toLowerCase().includes(q) || it.hint.includes(q)) : o.all.slice();
  if (o.mode === "plugins") return list;
  list.push({ label: "Open in JAgents Desktop", hint: "↗", desktop: "open" });
  list.push({ label: "Install JAgents Desktop", hint: "↓", desktop: "install" });
  return list;
}

function pick(item) {
  const o = overlay;
  if (!item) return;
  overlay = null;
  if (item.run) {
    Promise.resolve().then(item.run).catch((error) => flash(String(error.message || error), "danger"));
    return schedule();
  }
  if (item.desktop) {
    // Cancelling the install card brings back a required picker.
    const back = () => !tabs.length && !overlay && openPicker("tab", true);
    if (item.desktop === "install") return install(back);
    desktop();
    back();
    return;
  }
  askName(
    o.mode === "tab" ? "New terminal" : o.mode === "right" ? "Split right" : "Split down",
    defaultName(item.agent),
    (name) => {
      try {
        if (o.mode === "right") split(item.agent, "row", name);
        else if (o.mode === "down") split(item.agent, "col", name);
        else addTab(item.agent, name);
      } catch (error) {
        flash(String(error.message || error), "danger");
        if (!tabs.length) openPicker("tab", true);
      }
    },
    () => openPicker(o.mode, o.required),
    item.agent.name,
  );
}

// A one-line text box. Enter keeps the text (or the default when empty).
function askName(title, value, done, cancel, subtitle) {
  overlay = { kind: "name", title, subtitle: subtitle || "", value, fallback: value, done, cancel };
  schedule();
}

function renamePane(pane) {
  if (!pane) return;
  askName(
    "Rename terminal",
    pane.name,
    (name) => {
      pane.name = name;
      host.runtime?.emit("terminal-renamed", paneInfo(pane));
      schedule();
    },
    null,
    pane.agent.name,
  );
}

function openPlugins() {
  const runtime = host.runtime;
  if (!runtime) return flash("Plugins are unavailable until JAgents is restarted.", "warn");
  const state = runtime.plugins.list();
  const all = [
    { label: state.safeMode ? "Resume plugins" : "Safe mode: disable plugins", hint: "safe", run: () => { runtime.plugins.setSafeMode(!state.safeMode); openPlugins(); } },
    { label: "Create example plugin", hint: "new", run: async () => {
      let n = 1;
      while (state.plugins.some((p) => p.id === "my-plugin-" + n)) n++;
      await runtime.call("write_plugin", { id: "my-plugin-" + n, name: "My plugin " + n, files: { "main.cjs": 'exports.activate = (ctx) => {\n  ctx.terminal.commands.register({ id: "hello", label: "Say hello", handler: () => ctx.notify("Hello from my terminal plugin") });\n};\n' } });
      openPlugins();
    } },
  ];
  for (const command of runtime.commands()) all.push({ label: command.label, hint: command.plugin, run: () => runtime.call("run_command", { id: command.id }) });
  for (const plugin of state.plugins) {
    all.push({
      label: (plugin.enabled ? "Disable " : "Enable ") + plugin.name,
      hint: plugin.errors.main || plugin.errors.mcp ? "error" : plugin.enabled ? "on" : "off",
      run: async () => { await runtime.call("set_plugin_enabled", { id: plugin.id, enabled: !plugin.enabled }); openPlugins(); },
    });
    if (plugin.undoable) all.push({ label: "Undo " + plugin.name, hint: "undo", run: async () => { await runtime.call("undo_plugin", { id: plugin.id }); openPlugins(); } });
  }
  overlay = { kind: "picker", mode: "plugins", all, query: "", index: 0, required: false };
  schedule();
}

function pluginsChanged() {
  if (overlay?.mode !== "plugins") return;
  const previous = overlay;
  openPlugins();
  overlay.query = previous.query;
  overlay.index = Math.max(0, Math.min(previous.index, pickerItems(overlay).length - 1));
}

function paneInfo(pane) {
  return { id: pane.id, name: pane.name, provider: pane.agent.id, cwd: pane.cwd || cwd, pid: pane.proc.pid, exited: pane.exited, focused: tab()?.focus === pane };
}

function control(action, args = {}) {
  if (action === "list") return allPanes().map(paneInfo);
  if (action === "open") {
    if (args.name !== undefined && (typeof args.name !== "string" || !args.name.trim() || args.name.length > 80 || /[\x00-\x1f\x7f]/.test(args.name))) throw new Error("name must be 1-80 characters without control characters.");
    const provider = args.provider || "shell";
    const agent = listTerminalAgents().find((a) => a.id === provider);
    if (!agent?.available) throw new Error("Terminal provider is not installed: " + provider);
    if (args.mode && !["tab", "right", "down"].includes(args.mode)) throw new Error("mode must be tab, right or down.");
    const folder = args.cwd ? path.resolve(String(args.cwd)) : cwd;
    const pane = args.mode === "right" || args.mode === "down" ? split(agent, args.mode === "right" ? "row" : "col", args.name, folder) : addTab(agent, args.name, folder);
    overlay = null;
    schedule();
    return paneInfo(pane);
  }
  const pane = allPanes().find((p) => String(p.id) === String(args.id));
  if (!pane) throw new Error("No terminal pane " + args.id);
  if (action === "read") {
    const lines = args.lines === undefined ? 120 : Number(args.lines);
    if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw new Error("lines must be an integer from 1 to 2000.");
    return new Promise((resolve) => pane.term.write("", () => {
      const buffer = pane.term.buffer.active;
      const text = [];
      for (let i = Math.max(0, buffer.length - lines); i < buffer.length; i++) text.push(buffer.getLine(i)?.translateToString(true) || "");
      resolve({ id: pane.id, text: text.join("\n") });
    }));
  }
  if (action === "write") {
    if (pane.exited !== null) throw new Error("This terminal has exited.");
    if (typeof args.text !== "string") throw new Error("text must be a string.");
    pane.proc.write(args.text + (args.enter ? "\r" : ""));
    return { written: true, id: pane.id };
  }
  if (action === "rename") {
    if (typeof args.name !== "string" || !args.name.trim() || args.name.length > 80 || /[\x00-\x1f\x7f]/.test(args.name)) throw new Error("name must be 1-80 characters without control characters.");
    pane.name = args.name.trim();
    host.runtime?.emit("terminal-renamed", paneInfo(pane));
  } else if (action === "focus") focusPane(pane);
  else if (action === "close") { closePane(pane); return { closed: pane.id }; }
  else throw new Error("Unknown terminal action: " + action);
  schedule();
  return paneInfo(pane);
}

// The desktop install in progress, {step, pct}, or null. It lives in the
// host's state so a reload mid-install keeps showing it.
let installing = null;

// Opens the desktop app on this folder. Not installed: offers the install.
function desktop() {
  if (installing) return flash("JAgents Desktop is still installing.", "accent");
  if (!desk.desktopCommand(cwd)) return install();
  flash("Opening JAgents Desktop on " + path.basename(cwd) + "…", "accent");
  openDesktopNow();
}

function openDesktopNow() {
  desk.openDesktop(cwd, (err) => ui().flash(err || "JAgents Desktop is open on " + path.basename(cwd) + ".", err ? "danger" : "ok"));
}

// The install card: asks GitHub for the latest public release, warns when a
// copy is already installed (installing again replaces it with that
// release), and installs on Enter. onCancel runs when it is closed unasked.
function install(onCancel) {
  if (installing) return flash("JAgents Desktop is still installing.", "accent");
  const o = { kind: "install", have: desk.desktopVersion() || (desk.desktopSetupInstalled() ? "?" : ""), latest: null, error: "", onCancel };
  overlay = o;
  desk.latestRelease((err, release) => {
    if (err) o.error = String(err.message || err);
    else o.latest = release;
    ui().schedule();
  });
  schedule();
}

// Called from the card. Progress shows in the status line and on the
// Install buttons; when done the app opens (the setup starts it).
function runInstall() {
  overlay = null;
  installing = { step: "Starting…", pct: -1 };
  host.state.installing = installing;
  const status = installing;
  desk.installDesktop(
    (step, pct) => {
      status.step = step;
      status.pct = pct;
      ui().flash(step, "accent");
    },
    (err, done) => {
      const now = ui();
      now.installDone();
      if (err) return now.flash("Install failed: " + (err.message || err), "danger");
      now.flash("JAgents Desktop " + ((done && (done.version || done.tag)) || "") + " is installed.", "ok");
    },
  );
  schedule();
}

function closeInstall(o) {
  if (overlay === o) overlay = null;
  if (o.onCancel) o.onCancel();
  schedule();
}

function installDone() {
  installing = null;
  if (host) host.state.installing = null;
  desktopSeen.at = 0;
  schedule();
}

// The copy of this code that is on screen now. Callbacks from before a
// reload (an install, a release check) report through it.
function ui() {
  return (host && host.ui()) || module.exports;
}

// Checked at most every few seconds, since it touches the disk and registry.
let desktopSeen = { at: 0, value: false, version: "" };
function desktopState() {
  const now = Date.now();
  if (now - desktopSeen.at > 5000) desktopSeen = { at: now, value: Boolean(desk.desktopCommand(cwd)), version: desk.desktopVersion() };
  return desktopSeen;
}
function desktopInstalled() {
  return desktopState().value;
}

function toggleSidebar() {
  sidebar = !sidebar;
  host.runtime?.settings({ sidebar });
  prevRows = [];
  relayout();
  schedule();
}

function flash(text, tone) {
  note = { text, tone: tone || "warn" };
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => {
    note = null;
    schedule();
  }, 5000);
  schedule();
}

function quit() {
  if (quitting) return;
  quitting = true;
  for (const p of allPanes()) {
    try {
      if (p.exited === null) p.proc.kill();
    } catch {
      /* gone */
    }
  }
  host.quit();
}

const KEYS = [
  ["c", "New terminal"],
  [",", "Rename terminal"],
  ["%", "Split right"],
  ['"', "Split down"],
  ["o", "Next pane"],
  ["n  p", "Next or previous tab"],
  ["1-9", "Go to tab"],
  ["x", "Close terminal"],
  ["s", "Show or hide the sidebar"],
  ["e", "Plugins and plugin commands"],
  ["d", "Open JAgents Desktop"],
  ["i", "Install or reinstall JAgents Desktop"],
  ["q", "Quit"],
  ["Ctrl+B", "Send Ctrl+B to the terminal"],
];

// ---- drawing --------------------------------------------------------------

// The desktop app's dark theme (renderer/styles.css), as RGB.
const T = {
  canvas: "14;15;19",
  surface: "21;23;27",
  well: "31;33;39",
  line: "44;46;52",
  ink: "230;232;237",
  muted: "155;158;166",
  faint: "105;108;118",
  accent: "151;146;236",
  accentInk: "17;16;26",
  accentSoft: "43;42;70",
  ok: "102;193;137",
  warn: "235;178;95",
  danger: "233;120;113",
};
const DEFAULT_THEME = { ...T };

function applySettings(settings) {
  sidebar = settings.sidebar !== false;
  Object.assign(T, DEFAULT_THEME, settings.theme || {});
  prevRows = [];
  relayout();
  schedule();
}

function style(fg, bg, bold) {
  return "0" + (bold ? ";1" : "") + (fg ? ";38;2;" + T[fg] : "") + (bg ? ";48;2;" + T[bg] : "");
}

let prevRows = [];
let renderTimer = null;
let modes = { ckm: false, paste: false, keypad: false };

function schedule() {
  if (renderTimer || quitting || stopped) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 12);
}

function cellSgr(c) {
  let s = "0";
  if (c.isBold()) s += ";1";
  if (c.isDim()) s += ";2";
  if (c.isItalic()) s += ";3";
  if (c.isUnderline()) s += ";4";
  if (c.isBlink()) s += ";5";
  if (c.isInverse()) s += ";7";
  if (c.isInvisible()) s += ";8";
  if (c.isStrikethrough()) s += ";9";
  if (c.isFgRGB()) {
    const v = c.getFgColor();
    s += ";38;2;" + ((v >> 16) & 255) + ";" + ((v >> 8) & 255) + ";" + (v & 255);
  } else if (c.isFgPalette()) {
    const v = c.getFgColor();
    s += v < 8 ? ";" + (30 + v) : v < 16 ? ";" + (90 + v - 8) : ";38;5;" + v;
  }
  if (c.isBgRGB()) {
    const v = c.getBgColor();
    s += ";48;2;" + ((v >> 16) & 255) + ";" + ((v >> 8) & 255) + ";" + (v & 255);
  } else if (c.isBgPalette()) {
    const v = c.getBgColor();
    s += v < 8 ? ";" + (40 + v) : v < 16 ? ";" + (100 + v - 8) : ";48;5;" + v;
  }
  return s;
}

// The frame: per row, chars and SGR strings. "" marks the second half of a wide char.
function blankFrame(w, h) {
  const ch = [];
  const at = [];
  for (let y = 0; y < h; y++) {
    ch.push(new Array(w).fill(" "));
    at.push(new Array(w).fill("0"));
  }
  return { w, h, ch, at };
}

function put(f, x, y, text, sgr) {
  if (y < 0 || y >= f.h) return x;
  for (const c of text) {
    if (x >= f.w) break;
    if (x >= 0) {
      f.ch[y][x] = c;
      f.at[y][x] = sgr;
    }
    x++;
  }
  return x;
}

function fill(f, x, y, w, sgr) {
  return put(f, x, y, " ".repeat(Math.max(0, w)), sgr);
}

function clip(text, w) {
  const chars = Array.from(text);
  if (w <= 0) return "";
  return chars.length > w ? chars.slice(0, Math.max(0, w - 1)).join("") + "…" : text;
}

const hovered = (x0, x1, y) => mouse.y === y && mouse.x >= x0 && mouse.x < x1;

// A clickable label. Hover swaps to the hover style.
function button(f, x, y, text, sgr, hover, run) {
  const x1 = x + Array.from(text).length;
  const end = put(f, x, y, text, hover && hovered(x, x1, y) ? hover : sgr);
  hits.push({ x0: x, x1: end, y, run });
  return end;
}

function drawPane(f, pane) {
  const r = pane.rect;
  const buf = pane.term.buffer.active;
  const cell = buf.getNullCell();
  const top = buf.viewportY;
  for (let row = 0; row < r.h; row++) {
    const line = buf.getLine(top + row);
    if (!line) continue;
    const y = r.y + row;
    if (y >= f.h) break;
    for (let col = 0; col < r.w; col++) {
      const x = r.x + col;
      if (x >= f.w) break;
      const c = line.getCell(col, cell);
      if (!c) continue;
      const width = c.getWidth();
      if (width === 0) {
        f.ch[y][x] = "";
        continue;
      }
      if (width === 2 && col === r.w - 1) {
        f.ch[y][x] = " ";
        f.at[y][x] = cellSgr(c);
        continue;
      }
      f.ch[y][x] = c.getChars() || " ";
      f.at[y][x] = cellSgr(c);
    }
  }
}

// The Install button's label: progress while it runs.
function installLabel() {
  if (!installing) return "↓ Install";
  return installing.pct >= 0 ? "↓ " + installing.pct + "%" : "↓ …";
}

// Top row: tabs on the left, the desktop app's two actions on the right:
// open it on this folder, and install (or reinstall) it from GitHub.
function drawTabBar(f) {
  const bar = style("muted", "canvas");
  fill(f, 0, 0, f.w, bar);
  let x = put(f, 0, 0, " JAgents ", style("ink", "canvas", true));
  x = put(f, x, 0, " ", bar);

  const have = desktopInstalled();
  const inst = " " + installLabel() + " ";
  const open = " ↗ Desktop ";
  const ix = f.w - inst.length - 1;
  const dx = ix - open.length - 1;
  button(f, dx, 0, open, have ? style("accent", "accentSoft", true) : style("faint", "well"), style("accentInk", "accent", true), desktop);
  button(f, ix, 0, inst, installing ? style("accent", "well", true) : style("muted", "well", true), style("ink", "line", true), () => install());

  const plus = " + ";
  const room = dx - x - plus.length - 2;
  const each = tabs.length ? Math.max(8, Math.min(28, Math.floor(room / tabs.length))) : 0;
  tabs.forEach((t, i) => {
    if (x + each > dx - plus.length) return;
    const on = i === active;
    const panes = panesOf(t.root);
    const label = " " + t.focus.name + (panes.length > 1 ? " +" + (panes.length - 1) : "") + " ";
    const text = clip(label, each - 2);
    const bg = on ? "surface" : "canvas";
    const x0 = x;
    if (on) x = put(f, x, 0, "▎", style("accent", bg));
    else x = put(f, x, 0, " ", style(null, bg));
    x = button(f, x, 0, text, style(on ? "ink" : "muted", bg, on), style("ink", on ? "surface" : "well", on), () => selectTab(i));
    hits.push({ x0, x1: x0 + 1, y: 0, run: () => selectTab(i) });
    x = button(f, x, 0, "× ", style("faint", bg), style("danger", bg, true), () => closeTab(i));
  });
  x = put(f, x, 0, " ", bar);
  button(f, x, 0, plus, style("muted", "canvas", true), style("ink", "well", true), () => openPicker("tab"));
}

// Left column: every terminal, then actions, then the way to the desktop app.
function drawSidebar(f) {
  const w = sideWidth();
  if (!w) return;
  const bg = style("ink", "canvas");
  for (let y = 1; y < f.h - 1; y++) {
    fill(f, 0, y, w, bg);
    put(f, w, y, "│", style("line"));
  }
  const bottom = f.h - 6; // the desktop card takes the last rows
  let y = 2;
  const count = String(allPanes().length);
  put(f, 2, y, "TERMINALS", style("faint", "canvas", true));
  put(f, w - 1 - count.length, y, count, style("faint", "canvas"));
  y += 2;

  tabs.forEach((t, i) => {
    const panes = panesOf(t.root);
    for (const p of panes) {
      if (y >= bottom - 7) return;
      const sub = p !== panes[0];
      const on = i === active && t.focus === p;
      const rowBg = on ? "well" : "canvas";
      const hover = !on && hovered(0, w, y);
      const b = hover ? "surface" : rowBg;
      fill(f, 0, y, w, style(null, b));
      put(f, 0, y, on ? "▌" : " ", style("accent", b));
      let x = 2;
      if (sub) x = put(f, x, y, "└ ", style("faint", b));
      x = put(f, x, y, p.exited === null ? "●" : "○", style(p.exited === null ? "ok" : "faint", b));
      const id = clip(p.agent.id, 10);
      const nameW = w - x - 2 - id.length - 1;
      put(f, x + 1, y, clip(p.name, nameW), style(on ? "ink" : "muted", b, on));
      put(f, w - 1 - id.length, y, id, style("faint", b));
      hits.push({ x0: 0, x1: w, y, run: () => focusPane(p) });
      y++;
    }
  });

  y++;
  const action = (label, run) => {
    if (y >= bottom) return;
    const hover = hovered(0, w, y);
    fill(f, 0, y, w, style(null, hover ? "surface" : "canvas"));
    put(f, 2, y, label, style(hover ? "ink" : "muted", hover ? "surface" : "canvas"));
    hits.push({ x0: 0, x1: w, y, run });
    y++;
  };
  action("◇  Plugins", openPlugins);
  action("+  New terminal", () => openPicker("tab"));
  if (tab()) {
    action("→  Split right", () => openPicker("right"));
    action("↓  Split down", () => openPicker("down"));
    action("~  Rename", () => renamePane(tab().focus));
    action("×  Close", () => closePane(tab().focus));
  }

  // Desktop card: the full agent controller, in two parts. Open it on this
  // folder, or install the latest release from GitHub.
  const cy = f.h - 6;
  if (cy <= y) return;
  put(f, 1, cy, "─".repeat(w - 2), style("line", "canvas"));
  const ds = desktopState();
  const ver = ds.version ? "v" + ds.version.replace(/^v/i, "") : ds.value ? "" : "not installed";
  put(f, 2, cy + 1, "JAGENTS DESKTOP", style("faint", "canvas", true));
  put(f, w - 1 - ver.length, cy + 1, ver, style("faint", "canvas"));
  const row = (yy, label, tone, run) => {
    const hover = hovered(0, w, yy);
    const b = hover ? "accentSoft" : "canvas";
    fill(f, 0, yy, w, style(null, b));
    put(f, 2, yy, clip(label, w - 3), style(tone, b, true));
    hits.push({ x0: 0, x1: w, y: yy, run });
  };
  row(cy + 2, ds.value ? "↗  Open on this folder" : "↗  Open (install first)", ds.value ? "accent" : "faint", desktop);
  row(cy + 3, installing ? installLabel() + "  Installing…" : ds.value ? "↓  Reinstall latest" : "↓  Install latest", installing ? "accent" : "muted", () => install());
  put(f, 2, cy + 4, "Installs from GitHub.", style("faint", "canvas"));
}

// Bottom row: what Ctrl+B does, messages, and the folder.
function drawStatus(f) {
  const y = f.h - 1;
  const bg = style("faint", "canvas");
  fill(f, 0, y, f.w, bg);
  const folder = clip(cwd, Math.max(10, Math.floor(f.w / 3)));
  put(f, f.w - folder.length - 1, y, folder, style("faint", "canvas"));
  let x = 1;
  const key = (k, label) => {
    x = put(f, x, y, k, style("ink", "well", true));
    x = put(f, x, y, " " + label + "   ", bg);
  };
  if (prefixOn) {
    x = put(f, x, y, " Ctrl+B ", style("accentInk", "accent", true));
    x = put(f, x, y, "  ", bg);
    key(" c ", "new");
    key(" , ", "rename");
    key(" % ", "split right");
    key(' " ', "split down");
    key(" x ", "close");
    key(" d ", "desktop");
    key(" i ", "install");
    key(" ? ", "all keys");
    return;
  }
  if (note) {
    const tone = note.tone === "danger" ? "danger" : note.tone === "ok" ? "ok" : note.tone === "accent" ? "accent" : "warn";
    put(f, x, y, clip(note.text, f.w - folder.length - 4), style(tone, "canvas", true));
    return;
  }
  key(" Ctrl+B ", "then a key");
  key(" Ctrl+B ? ", "all keys");
}

// A centered card with a title row. Returns its box for content.
function drawCard(f, w, h, title, subtitle) {
  w = Math.min(f.w - 4, w);
  h = Math.min(f.h - 3, h);
  const x0 = Math.max(0, Math.floor((f.w - w) / 2));
  const y0 = Math.max(1, Math.floor((f.h - h) / 2));
  const body = style("ink", "surface");
  const border = style("line", "surface");
  put(f, x0, y0, "╭" + "─".repeat(w - 2) + "╮", border);
  for (let y = y0 + 1; y < y0 + h - 1; y++) {
    put(f, x0, y, "│", border);
    fill(f, x0 + 1, y, w - 2, body);
    put(f, x0 + w - 1, y, "│", border);
  }
  put(f, x0, y0 + h - 1, "╰" + "─".repeat(w - 2) + "╯", border);
  put(f, x0 + 3, y0 + 1, title, style("ink", "surface", true));
  if (subtitle) put(f, x0 + 3 + title.length + 2, y0 + 1, clip(subtitle, w - title.length - 8), style("faint", "surface"));
  return { x: x0 + 3, y: y0 + 3, w: w - 6, x0, y0, h };
}

function drawOverlay(f) {
  if (!overlay) return;
  const o = overlay;
  const hint = (b, text) => put(f, b.x, b.y0 + b.h - 2, clip(text, b.w), style("faint", "surface"));

  if (o.kind === "help") {
    const b = drawCard(f, 50, KEYS.length + 6, "Keys", "press Ctrl+B, then");
    KEYS.forEach(([k, label], i) => {
      put(f, b.x, b.y + i, (" " + k + " ").padEnd(9), style("ink", "well", true));
      put(f, b.x + 10, b.y + i, label, style("muted", "surface"));
    });
    return hint(b, "Any key closes this.");
  }
  if (o.kind === "install") {
    const latest = o.latest ? o.latest.tag || "the latest release" : "";
    const have = o.have === "?" ? "" : o.have ? "v" + o.have.replace(/^v/i, "") : "";
    const b = drawCard(f, 60, 12, o.have ? "Reinstall JAgents Desktop?" : "Install JAgents Desktop?", "from GitHub releases");
    const lines = [];
    if (o.error) lines.push(["Could not reach GitHub: " + o.error, "danger"]);
    else if (!o.latest) lines.push(["Checking GitHub for the latest release…", "muted"]);
    else if (o.have) {
      const same = desk.sameVersion(o.have, o.latest.tag);
      lines.push(["JAgents Desktop " + (have || "") + " is already installed.", "warn"]);
      lines.push([same ? "Installing again reinstalls " + latest + " over it." : "Installing replaces it with " + latest + ".", "warn"]);
      lines.push(["Your chats and settings stay.", "muted"]);
    } else {
      lines.push(["Downloads " + latest + " from GitHub releases and", "muted"]);
      lines.push(["installs it for you. No admin needed.", "muted"]);
    }
    if (o.latest || o.error) lines.push(["If the desktop app is open, close it first.", "faint"]);
    lines.forEach(([text, tone], i) => put(f, b.x, b.y + i, clip(text, b.w), style(tone, "surface", tone === "warn" || tone === "danger")));
    const by = b.y0 + b.h - 3;
    if (o.latest) {
      const go = " " + (o.have ? "Reinstall" : "Install") + " " + (o.latest.tag || "latest") + " ";
      const x = button(f, b.x, by, go, style("accentInk", "accent", true), style("accentInk", "ink", true), runInstall);
      button(f, x + 2, by, " Cancel ", style("ink", "well"), style("ink", "line"), () => closeInstall(o));
    } else button(f, b.x, by, " Close ", style("ink", "well"), style("ink", "line"), () => closeInstall(o));
    return hint(b, o.latest ? "Enter installs.  Esc cancels." : "Esc closes.");
  }
  if (o.kind === "confirm") {
    const n = allPanes().length;
    const b = drawCard(f, 46, 7, "Quit JAgents?");
    put(f, b.x, b.y, n + " terminal" + (n === 1 ? "" : "s") + " will close.", style("muted", "surface"));
    return hint(b, "Enter quits.  Esc stays.");
  }
  if (o.kind === "name") {
    const b = drawCard(f, 48, 8, o.title, o.subtitle);
    put(f, b.x, b.y, "Name", style("muted", "surface"));
    const fieldW = b.w;
    fill(f, b.x, b.y + 1, fieldW, style("ink", "well"));
    const shown = Array.from(o.value).slice(-(fieldW - 3)).join("");
    const end = put(f, b.x + 1, b.y + 1, shown, style("ink", "well"));
    put(f, end, b.y + 1, " ", style("accentInk", "accent"));
    return hint(b, "Enter saves.  Esc cancels.");
  }

  // Agent picker: type to filter, arrows and Enter, or click.
  const items = pickerItems(o);
  if (o.index >= items.length) o.index = items.length - 1;
  const title = o.mode === "plugins" ? "Plugins" : o.mode === "right" ? "Split right" : o.mode === "down" ? "Split down" : "New terminal";
  const listH = Math.min(items.length, Math.max(3, f.h - 14));
  const b = drawCard(f, 52, listH + 8, title, o.mode === "plugins" ? "commands, on/off and undo" : "pick an agent");
  fill(f, b.x, b.y, b.w, style("ink", "well"));
  if (o.query) {
    const end = put(f, b.x + 1, b.y, o.query, style("ink", "well"));
    put(f, end, b.y, " ", style("accentInk", "accent"));
  } else put(f, b.x + 1, b.y, "Type to filter", style("faint", "well"));
  const startAt = Math.max(0, Math.min(o.index - listH + 1, items.length - listH));
  for (let r = 0; r < listH; r++) {
    const i = startAt + r;
    const it = items[i];
    if (!it) break;
    const y = b.y + 2 + r;
    const on = i === o.index;
    const rowBg = on ? "accentSoft" : hovered(b.x - 1, b.x + b.w + 1, y) ? "well" : "surface";
    fill(f, b.x - 1, y, b.w + 2, style(null, rowBg));
    if (it.desktop) {
      put(f, b.x + 1, y, it.label + " " + it.hint, style("accent", rowBg, true));
    } else {
      put(f, b.x + 1, y, clip(it.label, b.w - 16), style(on ? "ink" : "muted", rowBg, on));
      const shownHint = clip(it.hint, 13);
      put(f, b.x + b.w - 1 - shownHint.length, y, shownHint, style("faint", rowBg));
    }
    hits.push({ x0: b.x - 1, x1: b.x + b.w + 1, y, run: () => pick(it) });
  }
  hint(b, "↑↓ Enter to pick." + (o.required ? "  Ctrl+C quits." : "  Esc closes."));
}

function drawEmpty(f) {
  const r = contentRect();
  const lines = ["JAgents " + pkg.version, cwd];
  lines.forEach((l, i) => put(f, r.x + Math.max(0, Math.floor((r.w - l.length) / 2)), r.y + 2 + i, l, style(i ? "faint" : "muted")));
}

function render() {
  if (quitting) return;
  const w = Math.max(1, out.columns || 80);
  const h = Math.max(3, out.rows || 24);
  const f = blankFrame(w, h);
  hits = [];
  const t = tab();
  if (t) {
    const panes = panesOf(t.root);
    for (const p of panes) drawPane(f, p);
    const r = t.focus.rect;
    for (const s of seps) {
      const touches = (s.x === r.x - 1 || s.x === r.x + r.w) && s.y >= r.y && s.y < r.y + r.h ? true : (s.y === r.y - 1 || s.y === r.y + r.h) && s.x >= r.x && s.x < r.x + r.w;
      put(f, s.x, s.y, s.ch, style(touches && panes.length > 1 ? "accent" : "line"));
    }
  } else drawEmpty(f);
  drawSidebar(f);
  drawTabBar(f);
  drawStatus(f);
  if (overlay) {
    hits = []; // only the card is clickable while it is open
    drawOverlay(f);
  }

  let s = "";
  for (let y = 0; y < h; y++) {
    let row = "";
    let last = "";
    for (let x = 0; x < w; x++) {
      const c = f.ch[y][x];
      if (c === "") continue;
      const a = f.at[y][x];
      if (a !== last) {
        row += CSI + a + "m";
        last = a;
      }
      row += c;
    }
    if (row !== prevRows[y]) s += CSI + (y + 1) + ";1H" + row + CSI + "0m";
    prevRows[y] = row;
  }
  prevRows.length = h;

  // The focused program's key modes and cursor, on the real terminal.
  const fp = t && t.focus;
  const m = fp ? fp.term.modes : {};
  const want = { ckm: Boolean(m.applicationCursorKeysMode), paste: Boolean(m.bracketedPasteMode), keypad: Boolean(m.applicationKeypadMode) };
  if (want.ckm !== modes.ckm) s += CSI + "?1" + (want.ckm ? "h" : "l");
  if (want.paste !== modes.paste) s += CSI + "?2004" + (want.paste ? "h" : "l");
  if (want.keypad !== modes.keypad) s += want.keypad ? ESC + "=" : ESC + ">";
  modes = want;
  let cursor = false;
  if (fp && !overlay && fp.exited === null) {
    const buf = fp.term.buffer.active;
    const hidden = fp.term._core && fp.term._core.coreService && fp.term._core.coreService.isCursorHidden;
    if (!hidden && buf.viewportY === buf.baseY) {
      cursor = true;
      s += CSI + (fp.rect.y + buf.cursorY + 1) + ";" + (fp.rect.x + Math.min(buf.cursorX, fp.rect.w - 1) + 1) + "H";
    }
  }
  s += CSI + "?25" + (cursor ? "h" : "l");
  out.write(s);
}

// ---- input ----------------------------------------------------------------

const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function paneAt(x, y) {
  const t = tab();
  if (!t) return null;
  return panesOf(t.root).find((p) => x >= p.rect.x && x < p.rect.x + p.rect.w && y >= p.rect.y && y < p.rect.y + p.rect.h) || null;
}

function onMouse(b, x1, y1, release) {
  const x = x1 - 1;
  const y = y1 - 1;
  const wheel = (b & 64) !== 0;
  const motion = (b & 32) !== 0;
  const button = b & 3;
  const press = !release && !motion && !wheel;
  const pane = overlay ? null : paneAt(x, y);

  if (!pane) {
    if (mouse.x !== x || mouse.y !== y) {
      mouse = { x, y };
      schedule();
    }
    if (overlay && overlay.kind === "picker" && wheel) {
      const n = pickerItems(overlay).length;
      overlay.index = (overlay.index + (button === 0 ? -1 : 1) + n) % n;
      return schedule();
    }
    if (!press || button !== 0) return;
    const hit = hits.find((h) => h.y === y && x >= h.x0 && x < h.x1);
    if (hit) hit.run();
    else if (overlay && !(overlay.kind === "picker" && overlay.required)) {
      const o = overlay;
      overlay = null;
      if (o.kind === "name" && o.cancel) o.cancel();
      if (o.kind === "install" && o.onCancel) o.onCancel();
    }
    return schedule();
  }

  if (mouse.x !== -1) {
    mouse = { x: -1, y: -1 };
    schedule();
  }
  const t = tab();
  if (press && t.focus !== pane) {
    t.focus = pane;
    schedule();
  }
  const mode = pane.term.modes.mouseTrackingMode;
  if (mode && mode !== "none" && pane.exited === null) {
    const sends = mode === "any" || (mode === "drag" && (!motion || button !== 3)) || (mode === "vt200" && !motion) || (mode === "x10" && press);
    if (sends) pane.proc.write(CSI + "<" + b + ";" + (x - pane.rect.x + 1) + ";" + (y - pane.rect.y + 1) + (release ? "m" : "M"));
    return;
  }
  if (wheel) {
    pane.term.scrollLines(button === 0 ? -3 : 3);
    schedule();
  }
}

function onPrefixKey(k) {
  prefixOn = false;
  const t = tab();
  if (k === PREFIX) return t && t.focus.exited === null && t.focus.proc.write(PREFIX);
  if (k === "c" || k === "t") return openPicker("tab");
  if (k === "%" || k === "|") return openPicker("right");
  if (k === '"' || k === "-") return openPicker("down");
  if (k === "n" || k === CSI + "C") return selectTab((active + 1) % Math.max(1, tabs.length));
  if (k === "p" || k === CSI + "D") return selectTab((active - 1 + tabs.length) % Math.max(1, tabs.length));
  if (k === "o" || k === CSI + "B") return cyclePane(1);
  if (k === CSI + "A") return cyclePane(-1);
  if (/^[1-9]$/.test(k)) return selectTab(Number(k) - 1);
  if (k === "x") return t && closePane(t.focus);
  if (k === "d") return desktop();
  if (k === "i") return install();
  if (k === ",") return t && renamePane(t.focus);
  if (k === "s") return toggleSidebar();
  if (k === "e") return openPlugins();
  if (k === "q") {
    overlay = { kind: "confirm" };
    return schedule();
  }
  if (k === "?") {
    overlay = { kind: "help" };
    return schedule();
  }
  schedule();
}

function onKeys(text) {
  if (!text) return;
  if (overlay) return overlayKeys(text);
  if (prefixOn) {
    // The key after Ctrl+B: one character, or one escape sequence.
    const k = KEY.exec(text)[1];
    onPrefixKey(k.replace(/^\x1bO/, CSI));
    schedule();
    return onKeys(text.slice(k.length));
  }
  const i = text.indexOf(PREFIX);
  if (i >= 0) {
    toPane(text.slice(0, i));
    prefixOn = true;
    schedule();
    return onKeys(text.slice(i + 1));
  }
  toPane(text);
}

function toPane(text) {
  if (!text) return;
  const t = tab();
  if (!t) return;
  const p = t.focus;
  if (p.exited !== null) {
    if (text.includes("\r")) closePane(p);
    return;
  }
  const buf = p.term.buffer.active;
  if (buf.viewportY !== buf.baseY) {
    p.term.scrollToBottom();
    schedule();
  }
  p.proc.write(text);
}

// One key at a time: an escape sequence, Alt+key, or one character.
const KEY = /^(\x1b\[[0-9;?]*[ -/]*[@-~]|\x1bO[@-~]|\x1b[\s\S]|[\s\S])/;

function overlayKeys(text) {
  while (text && overlay) {
    const k = KEY.exec(text)[1];
    text = text.slice(k.length);
    overlayKey(k);
  }
  if (text) onKeys(text);
}

const isUp = (k) => k === CSI + "A" || k === ESC + "OA";
const isDown = (k) => k === CSI + "B" || k === ESC + "OB";
const isBackspace = (k) => k === "\x7f" || k === "\b";
const isText = (k) => !k.startsWith(ESC) && k >= " " && k !== "\x7f";

function overlayKey(k) {
  const o = overlay;
  if (o.kind === "confirm") {
    overlay = null;
    if (k === "\r" || /^y/i.test(k)) return quit();
    return schedule();
  }
  if (o.kind === "help") {
    overlay = null;
    return schedule();
  }
  if (o.kind === "install") {
    if (k === "\r" && o.latest) return runInstall();
    if (k === ESC || k === "\x03" || k === "\r" || k === PREFIX) return closeInstall(o);
    return;
  }
  if (o.kind === "name") {
    if (k === "\r") {
      overlay = null;
      o.done(o.value.trim() || o.fallback);
    } else if (k === ESC || k === "\x03") {
      overlay = null;
      if (o.cancel) o.cancel();
    } else if (isBackspace(k)) o.value = Array.from(o.value).slice(0, -1).join("");
    else if (k === "\x15") o.value = "";
    else if (isText(k) && o.value.length < 40) o.value += k;
    return schedule();
  }
  const items = pickerItems(o);
  if (isUp(k)) o.index = (o.index - 1 + items.length) % items.length;
  else if (isDown(k) || k === "\t") o.index = (o.index + 1) % items.length;
  else if (k === "\r") return pick(items[o.index]);
  else if (isBackspace(k)) {
    o.query = Array.from(o.query).slice(0, -1).join("");
    o.index = 0;
  } else if (k === ESC || k === PREFIX) {
    if (o.query) {
      o.query = "";
      o.index = 0;
    } else if (!o.required) overlay = null;
  } else if (k === "\x03") {
    if (o.required) return quit();
    overlay = null;
  } else if (isText(k)) {
    o.query += k;
    o.index = 0;
  }
  schedule();
}

const decoder = new StringDecoder("utf8");
let pending = "";
function onInput(chunk) {
  let text = pending + decoder.write(chunk);
  pending = "";
  // Keep an unfinished mouse report for the next chunk.
  const cut = /\x1b(\[(<[\d;]*)?)?$/.exec(text);
  if (cut && cut[0].length > 1) {
    pending = cut[0];
    text = text.slice(0, cut.index);
  }
  let last = 0;
  MOUSE.lastIndex = 0;
  let m;
  while ((m = MOUSE.exec(text))) {
    onKeys(text.slice(last, m.index));
    onMouse(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === "m");
    last = MOUSE.lastIndex;
  }
  onKeys(text.slice(last));
}

function onResize() {
  prevRows = [];
  out.write(CSI + "2J");
  relayout();
  schedule();
}

// ---- start and stop -------------------------------------------------------

// host: {state, pty, Terminal, argv, ui(), quit(), reloaded}. state is
// empty on the first start; after a reload it holds what stop() left.
function start(h) {
  host = h;
  pty = h.pty;
  Terminal = h.Terminal;
  stopped = false;
  if (h.runtime) {
    const settings = h.runtime.settings();
    Object.assign(T, DEFAULT_THEME, settings.theme || {});
    sidebar = settings.sidebar !== false;
  }
  const s = h.state;
  if (s.tabs) {
    tabs = s.tabs;
    active = s.active;
    sidebar = s.sidebar;
    seq = s.seq;
    installing = s.installing || null;
    modes = s.modes || modes;
    for (const p of allPanes()) wire(p);
    h.runtime?.activate();
    prevRows = [];
    relayout();
    if (!tabs.length) openPicker("tab", true);
    if (h.reloaded) flash("JAgents reloaded with the new code (" + pkg.version + "). Your terminals kept running.", "ok");
    return schedule();
  }
  h.runtime?.activate();
  const argv = h.argv || [];
  const first = argv[0] && listTerminalAgents().find((a) => a.id === argv[0] || a.name.toLowerCase() === argv.join(" ").toLowerCase());
  if (argv[0] && !first) flash("No terminal agent called " + argv[0] + ". jagents --list shows them.", "danger");
  if (first && !first.available) flash(first.name + " is not installed. " + first.install, "danger");
  if (first && first.available) addTab(first);
  else openPicker("tab", true);
  schedule();
}

// Lets go of the screen and the panes, and leaves the state for the next copy.
function stop() {
  stopped = true;
  clearTimeout(renderTimer);
  renderTimer = null;
  clearTimeout(noteTimer);
  for (const p of allPanes()) unwire(p);
  Object.assign(host.state, { tabs, active, sidebar, seq, installing, modes });
}

module.exports = { start, stop, onInput, onResize, flash, schedule, installDone, control, applySettings, pluginsChanged };
