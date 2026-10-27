// A terminal pane: xterm.js in the renderer, attached to a node-pty process in
// the main process. The process outlives the view, so moving a pane between
// layouts or reloading the window reattaches and replays the screen.

import { esc, toast, errorText } from "./util.js";
import { icon } from "./icons.js";
import { on, fire, store } from "./store.js";
import { dropdown } from "./dialogs.js";
import { THEMES, DEFAULT_DARK, DEFAULT_LIGHT, isLightTheme } from "./terminal-themes.js";

const views = new Map(); // paneId -> TerminalView

// The ResizeObserver alone missed layout changes: when Grid changed shape
// (2x2 to three tall columns) panes were moved, and terminals kept the old
// cols and rows until something else resized them. So every layout change,
// and the window coming back into view, refits each terminal directly once
// the new arrangement has settled.
function refitAll() {
  for (const v of views.values()) v.queueRefit();
}
on("app:layout", refitAll);
window.addEventListener("resize", refitAll);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  refitAll();
  // The GPU canvas may have dropped its last frame while hidden; redraw it.
  for (const v of views.values()) if (v.webgl) v.term.refresh(0, v.term.rows - 1);
});

export function routePtyData({ id, data }) {
  const v = views.get(id);
  if (!v) return;
  v.term.write(data);
  noteOutput(v);
}

// Whether the agent is working, for the tab: output that keeps coming for a
// moment and is not the echo of typing or a redraw after a resize. Fires
// "term-activity" with {id, busy, worked} (ms of work) when it changes.
const ECHO_MS = 600;
const BUSY_AFTER_MS = 800;
const IDLE_AFTER_MS = 1600;
const STARTUP_MS = 15000;

function noteOutput(v) {
  const now = Date.now();
  if (!v.busy && (now < v.lastInput + ECHO_MS || now < v.quietUntil)) return;
  if (!v.burstStart) v.burstStart = now;
  clearTimeout(v.idleTimer);
  v.idleTimer = setTimeout(() => {
    let worked = v.busy ? Date.now() - v.burstStart : 0;
    // Before anything was typed in, a short burst is the agent starting up
    // (banner, loading MCP servers), not finished work. One started with a
    // task works for longer than that.
    if (!v.lastInput && worked < STARTUP_MS) worked = 0;
    v.burstStart = 0;
    if (!v.busy) return;
    v.busy = false;
    fire("term-activity", { id: v.pane.id, busy: false, worked });
  }, IDLE_AFTER_MS);
  if (!v.busy && now - v.burstStart >= BUSY_AFTER_MS) {
    v.busy = true;
    fire("term-activity", { id: v.pane.id, busy: true, worked: 0 });
  }
}

export function terminalBusy(id) {
  const v = views.get(id);
  return Boolean(v && v.busy);
}

export function routePtyExit({ id, exitCode }) {
  const v = views.get(id);
  if (v) v.showExit(exitCode);
}

function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

// Settings > Terminal. The defaults match Orca's terminals.
export const TERM_FONTS = ["Cascadia Mono", "JetBrains Mono", "Cascadia Code", "Consolas"];
export const TERM_WEIGHTS = [300, 400, 500, 600];
export const TERM_LINE_HEIGHTS = [1, 1.1, 1.2, 1.3];
export const TERM_CURSORS = ["block", "bar", "underline"];
const DEFAULTS = { themeDark: DEFAULT_DARK, themeLight: DEFAULT_LIGHT, font: "Cascadia Mono", fontSize: 14, fontWeight: 500, lineHeight: 1, cursorStyle: "block", cursorBlink: true };

export function termSettings() {
  const s = Object.assign({}, DEFAULTS, (store.info && store.info.terminal) || {});
  if (!THEMES[s.themeDark]) s.themeDark = DEFAULTS.themeDark;
  if (!THEMES[s.themeLight]) s.themeLight = DEFAULTS.themeLight;
  if (!TERM_FONTS.includes(s.font)) s.font = DEFAULTS.font;
  s.fontSize = Math.min(24, Math.max(9, Math.round(Number(s.fontSize)) || DEFAULTS.fontSize));
  if (!TERM_WEIGHTS.includes(s.fontWeight)) s.fontWeight = DEFAULTS.fontWeight;
  if (!TERM_LINE_HEIGHTS.includes(s.lineHeight)) s.lineHeight = DEFAULTS.lineHeight;
  if (!TERM_CURSORS.includes(s.cursorStyle)) s.cursorStyle = DEFAULTS.cursorStyle;
  s.cursorBlink = s.cursorBlink !== false;
  return s;
}

export async function setTermSettings(patch) {
  store.info.terminal = patch ? Object.assign({}, store.info.terminal || {}, patch) : null;
  applyTermSettings();
  await window.jagents.setSetting("terminal", store.info.terminal);
}

export function themeName(s = termSettings()) {
  return isDark() ? s.themeDark : s.themeLight;
}

// The scrollbar is drawn by xterm; a neutral gray reads on every theme.
function xtermTheme(s) {
  return Object.assign({ scrollbarSliderBackground: "rgba(180, 180, 185, 0.4)", scrollbarSliderHoverBackground: "rgba(180, 180, 185, 0.6)", scrollbarSliderActiveBackground: "rgba(180, 180, 185, 0.8)" }, THEMES[themeName(s)]);
}

// Agent CLIs print dim grays meant for one background; xterm brightens text
// that would be too faint to read on this one.
function contrast(s) {
  return isLightTheme(themeName(s)) ? 4.5 : 3;
}

// The chosen font, then Windows' terminal fonts for anything it lacks, then
// Nerd Font icons for shell prompts.
function fontStack(font) {
  const list = [font, "Cascadia Mono", "Consolas", "Symbols Nerd Font Mono"].filter((f, i, a) => a.indexOf(f) === i);
  return list.map((f) => '"' + f + '"').join(", ") + ", monospace";
}

function termOptions(s) {
  return {
    fontFamily: fontStack(s.font),
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
    fontWeightBold: 700,
    lineHeight: s.lineHeight,
    cursorStyle: s.cursorStyle,
    cursorInactiveStyle: s.cursorStyle === "block" ? "outline" : s.cursorStyle,
    cursorBlink: s.cursorBlink,
    theme: xtermTheme(s),
    minimumContrastRatio: contrast(s),
  };
}

// Theme, font and cursor for every open terminal (and the Settings preview).
export function applyTermSettings() {
  const s = termSettings();
  document.documentElement.style.setProperty("--term-bg", THEMES[themeName(s)].background);
  loadTermFont(s).then(() => {
    const opts = termOptions(s);
    for (const v of [...views.values(), ...previews]) {
      if (v.disposed) continue;
      for (const [k, val] of Object.entries(opts)) v.term.options[k] = val;
      v.queueRefit();
    }
  });
}

export const retheme = applyTermSettings;

const fontLoads = new Map();

// xterm measures the cell once. Measured before the font is loaded it gets a
// fallback font's cell, and text overlaps or gaps until the next resize.
function loadTermFont(s) {
  const key = s.font + "|" + s.fontWeight;
  if (!fontLoads.has(key)) {
    const f = '"' + s.font + '"';
    const load = Promise.all([document.fonts.load(s.fontWeight + " 14px " + f), document.fonts.load("700 14px " + f), document.fonts.load('14px "Symbols Nerd Font Mono"', "")]).catch(() => {});
    fontLoads.set(key, Promise.race([load, new Promise((r) => setTimeout(r, 1500))]));
  }
  return fontLoads.get(key);
}

// A terminal with sample output and no process, for Settings > Terminal.
const previews = new Set();
const SAMPLE = [
  "\x1b[38;2;215;119;87m ▐▛███▜▌\x1b[0m   \x1b[1mClaude Code\x1b[0m \x1b[90mv2.1\x1b[0m",
  "\x1b[38;2;215;119;87m▝▜█████▛▘\x1b[0m  \x1b[90mOpus · ~/JAgents\x1b[0m",
  "\x1b[38;2;215;119;87m  ▘▘ ▝▝\x1b[0m",
  "",
  "\x1b[32m\x1b[42;30m  main \x1b[0m\x1b[32m\x1b[0m \x1b[36m~/JAgents\x1b[0m \x1b[1m❯\x1b[0m npm test",
  "\x1b[32m✔\x1b[0m terminal themes \x1b[90m(12 ms)\x1b[0m   \x1b[31m✖\x1b[0m \x1b[1;31mone failed\x1b[0m   \x1b[33m⚠ warning\x1b[0m",
  "┌──────────┬────────┐   \x1b[34mblue\x1b[0m \x1b[35mmagenta\x1b[0m \x1b[36mcyan\x1b[0m \x1b[37mwhite\x1b[0m",
  "│ \x1b[1mFile\x1b[0m     │ \x1b[1mStatus\x1b[0m │   \x1b[94mbright\x1b[0m \x1b[95mbright\x1b[0m \x1b[96mbright\x1b[0m \x1b[97mbright\x1b[0m",
  "└──────────┴────────┘   \x1b[2mdim text\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4munderline\x1b[0m",
].join("\r\n");

// Its height follows the font (ten rows); only the width is fitted.
export function mountTermPreview(el) {
  const s = termSettings();
  const p = { term: new window.Terminal(Object.assign({ rows: 10, cols: 72, allowProposedApi: true, disableStdin: true, scrollback: 0 }, termOptions(s))) };
  p.fit = new window.FitAddon.FitAddon();
  p.term.loadAddon(p.fit);
  p.queueRefit = () =>
    setTimeout(() => {
      const d = !p.disposed && p.term.element && p.fit.proposeDimensions();
      if (d && d.cols) p.term.resize(d.cols, 10);
    }, 0);
  if (window.Unicode11Addon) {
    p.term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
    p.term.unicode.activeVersion = "11";
  }
  previews.add(p);
  loadTermFont(s).then(() => {
    if (p.disposed) return;
    p.term.open(el);
    if (window.WebglAddon) {
      try {
        p.term.loadAddon(new window.WebglAddon.WebglAddon());
      } catch {
        /* the DOM renderer draws it */
      }
    }
    p.queueRefit();
    p.term.write(SAMPLE);
    p.term.write("\x1b[?25h");
  });
  return () => {
    p.disposed = true;
    previews.delete(p);
    p.term.dispose();
  };
}

// Ctrl+= and Ctrl+- (or Ctrl+wheel) change the text size of every terminal,
// the same setting as Settings > Terminal > Size. Ctrl+0 goes back to 14.
function zoomTerminals(step, view) {
  const s = termSettings();
  const size = step ? Math.min(24, Math.max(9, s.fontSize + step)) : DEFAULTS.fontSize;
  if (view) view.flashHint("Text size " + size);
  if (size !== s.fontSize) setTermSettings({ fontSize: size });
}

// Search highlights: every match, and a stronger one for the current match.
function findColors() {
  return isLightTheme(themeName())
    ? { matchBackground: "#fff0a6", matchBorder: "#e0c341", matchOverviewRuler: "#d4a72c", activeMatchBackground: "#ffc94d", activeMatchBorder: "#a87800", activeMatchColorOverviewRuler: "#a87800" }
    : { matchBackground: "#4a4020", matchBorder: "#8a7633", matchOverviewRuler: "#c9a03a", activeMatchBackground: "#7a5c0c", activeMatchBorder: "#ffcc33", activeMatchColorOverviewRuler: "#ffcc33" };
}

// A dropped file's path, quoted when it has spaces or shell characters.
function quotePath(p) {
  return /[\s&()[\]{}^=;!'+,`~$@#%]/.test(p) ? '"' + p + '"' : p;
}

// One anchor for the right-click menu, moved to the pointer each time.
let menuAnchor = null;
function anchorAt(x, y) {
  if (!menuAnchor) {
    menuAnchor = document.createElement("div");
    menuAnchor.className = "term-menu-anchor";
    document.body.appendChild(menuAnchor);
  }
  menuAnchor.style.left = x + "px";
  menuAnchor.style.top = y - 6 + "px";
  return menuAnchor;
}

const menuIcon = (name) => '<span class="menu-ic">' + icon(name, 16) + "</span>";

// Agent CLIs take Esc+Enter as a new line in their prompt; xterm sends Enter
// and Shift+Enter the same. A plain shell gets Enter as typed.
function newlineOnShiftEnter(provider) {
  return provider !== "shell";
}

export class TerminalView {
  constructor(el, pane) {
    this.el = el;
    this.pane = pane;
    this.el.classList.add("termview");
    this.el.innerHTML =
      '<div class="xterm-host"></div>' +
      '<div class="term-find" role="search" hidden><span class="tf-ic">' + icon("search", 14) + "</span>" +
      '<input type="text" placeholder="Find" aria-label="Find in terminal" spellcheck="false" autocomplete="off">' +
      '<span class="tf-count" aria-live="polite"></span>' +
      '<button type="button" class="tf-btn tf-case" data-find-case aria-pressed="false" title="Match case">Aa</button>' +
      '<button type="button" class="tf-btn" data-find-prev title="Previous match (Shift+Enter)" aria-label="Previous match">' + icon("chevronUp", 15) + "</button>" +
      '<button type="button" class="tf-btn" data-find-next title="Next match (Enter)" aria-label="Next match">' + icon("chevronDown", 15) + "</button>" +
      '<button type="button" class="tf-btn" data-find-close title="Close (Esc)" aria-label="Close find">' + icon("close", 13) + "</button></div>" +
      '<button type="button" class="term-bottom" hidden title="Jump to the latest output" aria-label="Jump to the latest output">' + icon("arrowDown", 15) + "</button>" +
      '<div class="term-hint" hidden></div>' +
      '<div class="term-exit" hidden></div>';
    this.host = this.el.querySelector(".xterm-host");
    this.exitEl = this.el.querySelector(".term-exit");
    this.findEl = this.el.querySelector(".term-find");
    this.findInput = this.findEl.querySelector("input");
    this.findCount = this.findEl.querySelector(".tf-count");
    this.bottomEl = this.el.querySelector(".term-bottom");
    this.hintEl = this.el.querySelector(".term-hint");
    const info = store.info || {};
    const settings = termSettings();
    this.term = new window.Terminal(
      Object.assign(termOptions(settings), {
        allowProposedApi: true,
        scrollback: 8000,
        // Wide symbols (⏺, ✻) are drawn inside their cell instead of over the next.
        rescaleOverlappingGlyphs: true,
        // ConPTY repaints the screen itself after a resize; without this xterm
        // reflows the lines too and they come out doubled or cut.
        windowsPty: info.platform === "win32" ? { backend: "conpty", buildNumber: info.osBuild || undefined } : undefined,
      }),
    );
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    if (window.Unicode11Addon) {
      // Emoji and symbol widths as agent CLIs count them, so columns line up.
      this.term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      this.term.unicode.activeVersion = "11";
    }
    if (window.SearchAddon) {
      this.search = new window.SearchAddon.SearchAddon();
      this.term.loadAddon(this.search);
      this.search.onDidChangeResults(({ resultIndex, resultCount }) => {
        this.findCount.textContent = !this.findInput.value ? "" : !resultCount ? "No results" : resultIndex < 0 ? resultCount + "+ matches" : resultIndex + 1 + " of " + resultCount;
        this.findEl.classList.toggle("none", Boolean(this.findInput.value) && !resultCount);
      });
    }
    // Web addresses underline on hover and open with Ctrl+click, so a stray
    // click while selecting text does not open a browser.
    if (window.WebLinksAddon) {
      this.term.loadAddon(
        new window.WebLinksAddon.WebLinksAddon(
          (e, uri) => {
            if (e.ctrlKey || e.metaKey) window.jagents.openUrl(uri).catch((err) => toast(errorText(err)));
            else this.flashHint("Ctrl+click to open the link", e);
          },
          { hover: (e) => this.showHint("Ctrl+click to open", e), leave: () => this.hideHint() },
        ),
      );
    }
    this.lastInput = 0;
    this.quietUntil = Date.now() + 3000; // the screen replays on attach
    this.term.onData((data) => {
      this.lastInput = Date.now();
      window.jagents.pty.write(pane.id, data);
    });
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Ctrl+Tab switches tabs (code-mode), not a key for the agent.
      if (e.ctrlKey && e.key === "Tab") return false;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "c" && this.term.hasSelection()) {
        e.preventDefault();
        this.copy();
        return false;
      }
      // Ctrl+Shift+C and V copy and paste too, as in Windows Terminal.
      if (mod && e.shiftKey && !e.altKey && key === "c") {
        e.preventDefault();
        this.copy();
        return false;
      }
      if (mod && !e.altKey && key === "v") {
        e.preventDefault();
        this.paste();
        return false;
      }
      if (mod && e.shiftKey && !e.altKey && key === "f") {
        e.preventDefault();
        this.openFind();
        return false;
      }
      // (Ctrl+Shift+- stays Ctrl+_, the shell's undo.)
      if (mod && !e.altKey && (key === "=" || key === "+" || key === "-" || (key === "0" && !e.shiftKey))) {
        e.preventDefault();
        zoomTerminals(key === "0" ? 0 : key === "-" ? -1 : 1, this);
        return false;
      }
      if (e.key === "Enter" && e.shiftKey && !mod && !e.altKey && newlineOnShiftEnter(pane.provider)) {
        e.preventDefault();
        window.jagents.pty.write(pane.id, "\x1b\r");
        return false;
      }
      return true;
    });
    views.set(pane.id, this);
    this.ro = new ResizeObserver(() => this.refit());
    this.ro.observe(this.host);
    this.exitEl.addEventListener("click", (e) => {
      if (e.target.closest("[data-restart]")) this.restart();
    });
    this.wireFind();
    this.wireExtras();
    loadTermFont(settings).then(() => {
      if (this.disposed) return;
      this.term.open(this.host);
      this.useWebgl();
      this.attach();
    });
  }

  // The WebGL renderer draws block and box characters (Claude Code's logo, TUI
  // borders) to fill the whole cell so they join up; the DOM renderer took
  // them from the font and left gaps between rows. It is also much faster
  // while agents stream output. Without WebGL the DOM renderer stays.
  useWebgl() {
    if (!window.WebglAddon) return;
    try {
      const gl = new window.WebglAddon.WebglAddon();
      gl.onContextLoss(() => {
        gl.dispose();
        if (this.webgl === gl) this.webgl = null;
        // The GPU process restarted (driver update, sleep): try again shortly.
        clearTimeout(this.webglRetry);
        this.webglRetry = setTimeout(() => !this.disposed && !this.webgl && this.useWebgl(), 1000);
      });
      this.term.loadAddon(gl);
      this.webgl = gl;
    } catch {
      this.webgl = null;
    }
    this.queueRefit();
  }

  copy() {
    if (!this.term.hasSelection()) return;
    navigator.clipboard.writeText(this.term.getSelection());
    this.term.clearSelection();
  }

  // No text on the clipboard (a screenshot): pass Ctrl+V on so the agent can
  // read the image itself.
  paste() {
    const passOn = () => window.jagents.pty.write(this.pane.id, "\x16");
    navigator.clipboard.readText().then((t) => (t ? this.term.paste(t) : passOn()), passOn);
  }

  // Ctrl+Shift+F: a find bar over the top right corner. Enter and Shift+Enter
  // go through the matches; every match is highlighted and marked on the
  // scrollbar.
  wireFind() {
    this.runFind = (forward, incremental) => {
      if (!this.search) return;
      const q = this.findInput.value;
      if (!q) {
        this.search.clearDecorations();
        this.findCount.textContent = "";
        this.findEl.classList.remove("none");
        return;
      }
      const opts = { caseSensitive: Boolean(this.findCase), incremental, decorations: findColors() };
      if (forward) this.search.findNext(q, opts);
      else this.search.findPrevious(q, opts);
    };
    this.findInput.addEventListener("input", () => this.runFind(true, true));
    this.findInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.runFind(!e.shiftKey, false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.closeFind();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        this.findInput.select();
      }
    });
    this.findEl.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.hasAttribute("data-find-close")) return this.closeFind();
      if (b.hasAttribute("data-find-case")) {
        this.findCase = !this.findCase;
        b.setAttribute("aria-pressed", String(this.findCase));
        if (this.search) this.search.clearDecorations();
        this.runFind(true, true);
      } else this.runFind(b.hasAttribute("data-find-next"), false);
      this.findInput.focus();
    });
  }

  openFind() {
    if (!this.search) return;
    const sel = this.term.hasSelection() ? this.term.getSelection() : "";
    if (sel && !sel.includes("\n") && sel.length < 200) this.findInput.value = sel;
    this.findEl.hidden = false;
    this.findInput.focus();
    this.findInput.select();
    if (this.findInput.value) this.runFind(true, true);
  }

  closeFind() {
    if (this.findEl.hidden) return;
    this.findEl.hidden = true;
    if (this.search) this.search.clearDecorations();
    this.term.clearSelection();
    this.term.focus();
  }

  // The right-click menu, Ctrl+wheel text size, the jump-to-latest button and
  // dropping files in.
  wireExtras() {
    // A full-screen app that reads the mouse gets the right click instead;
    // Shift+right-click still opens the menu there.
    this.el.addEventListener("contextmenu", (e) => {
      if (!e.target.closest(".xterm-host")) return;
      e.preventDefault();
      if (this.term.modes.mouseTrackingMode !== "none" && !e.shiftKey) return;
      this.openMenu(e.clientX, e.clientY);
    });
    this.el.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        const now = Date.now();
        if (!e.deltaY || now - (this.lastZoom || 0) < 90) return;
        this.lastZoom = now;
        zoomTerminals(e.deltaY < 0 ? 1 : -1, this);
      },
      { passive: false, capture: true },
    );
    // Scrolled back through the history: a button jumps to the latest output
    // and lights up when more arrives.
    this.bottomEl.addEventListener("click", () => {
      this.term.scrollToBottom();
      this.term.focus();
    });
    this.term.onScroll(() => this.paintBottom());
    this.term.onWriteParsed(() => {
      if (this.scrolledUp) this.bottomEl.classList.add("new");
    });
    // Dropped files are typed in as their paths (an agent reads them, a
    // dropped image becomes an attachment in Claude Code).
    const hasFiles = (e) => Boolean(e.dataTransfer) && Array.from(e.dataTransfer.types || []).includes("Files");
    this.el.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      this.el.classList.add("drop-files");
    });
    this.el.addEventListener("dragleave", (e) => {
      if (!this.el.contains(e.relatedTarget)) this.el.classList.remove("drop-files");
    });
    this.el.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.el.classList.remove("drop-files");
      const paths = Array.from(e.dataTransfer.files).map((f) => window.jagents.pathForFile(f)).filter(Boolean);
      if (!paths.length) return;
      this.term.paste(paths.map(quotePath).join(" "));
      this.term.focus();
    });
  }

  paintBottom() {
    const b = this.term.buffer.active;
    const up = b.viewportY < b.baseY;
    if (up === Boolean(this.scrolledUp)) return;
    this.scrolledUp = up;
    this.bottomEl.hidden = !up;
    if (!up) this.bottomEl.classList.remove("new");
  }

  openMenu(x, y) {
    const pick = (fn) => () => {
      fn();
      if (this.findEl.hidden) this.term.focus();
    };
    const items = [
      { label: "Copy", icon: menuIcon("copy"), badge: "Ctrl+C", disabled: !this.term.hasSelection(), onPick: pick(() => this.copy()) },
      { label: "Paste", icon: menuIcon("paste"), badge: "Ctrl+V", onPick: pick(() => this.paste()) },
      { label: "Select all", icon: menuIcon("selectAll"), onPick: pick(() => this.term.selectAll()) },
      { divider: true },
      { label: "Find", icon: menuIcon("search"), badge: "Ctrl+Shift+F", onPick: () => this.openFind() },
      // Only the history above the screen; what the agent shows now stays.
      { label: "Clear scrollback", icon: menuIcon("trash"), onPick: pick(() => this.term.write("\x1b[3J")) },
      { divider: true },
      { label: "Larger text", icon: menuIcon("textSize"), badge: "Ctrl+=", onPick: pick(() => zoomTerminals(1, this)) },
      { label: "Smaller text", icon: menuIcon("textSize"), badge: "Ctrl+-", onPick: pick(() => zoomTerminals(-1, this)) },
    ];
    dropdown(anchorAt(x, y), items, { width: 260 });
  }

  // A small label: "Ctrl+click to open" by the pointer, or the text size at
  // the top of the terminal.
  showHint(text, e) {
    clearTimeout(this.hintTimer);
    this.hintEl.textContent = text;
    this.hintEl.hidden = false;
    const at = Boolean(e);
    this.hintEl.classList.toggle("at", at);
    if (at) {
      const r = this.el.getBoundingClientRect();
      this.hintEl.style.left = Math.max(8, Math.min(r.width - 190, e.clientX - r.left + 12)) + "px";
      this.hintEl.style.top = Math.max(8, Math.min(r.height - 34, e.clientY - r.top + 16)) + "px";
    } else {
      this.hintEl.style.left = "";
      this.hintEl.style.top = "";
    }
  }

  hideHint() {
    clearTimeout(this.hintTimer);
    this.hintEl.hidden = true;
  }

  flashHint(text, e) {
    this.showHint(text, e);
    this.hintTimer = setTimeout(() => this.hideHint(), 1100);
  }

  size() {
    return { cols: this.term.cols, rows: this.term.rows };
  }

  queueRefit() {
    clearTimeout(this.refitTimer);
    clearTimeout(this.refitLate);
    this.refitTimer = setTimeout(() => this.refit(), 0);
    // Again once fonts and the rest of the layout have caught up.
    this.refitLate = setTimeout(() => this.refit(), 150);
  }

  refit() {
    if (!this.term.element || !this.host.offsetWidth || !this.host.offsetHeight) return;
    try {
      this.fit.fit();
    } catch {
      return;
    }
    const s = this.size();
    if (this.lastSize && this.lastSize.cols === s.cols && this.lastSize.rows === s.rows) return;
    this.lastSize = s;
    if (!this.attached) return;
    // The agent redraws for the new size; that is not work.
    this.quietUntil = Date.now() + 1200;
    window.jagents.pty.resize(this.pane.id, s.cols, s.rows);
  }

  async attach() {
    // A timer, not requestAnimationFrame: rAF never fires while the window is
    // hidden or covered, and the process must start regardless.
    await new Promise((r) => setTimeout(r, 30));
    try {
      this.fit.fit();
    } catch {
      /* not laid out yet */
    }
    try {
      const snap = await window.jagents.pty.attach(this.pane.id, this.size());
      this.attached = true;
      this.lastSize = this.size();
      if (snap && snap.data) this.term.write(snap.data);
      if (snap && snap.exited) this.showExit(snap.exitCode);
    } catch (error) {
      this.term.write("\r\n\x1b[31m" + String(error.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") + "\x1b[0m\r\n");
    }
  }

  async restart() {
    this.exitEl.hidden = true;
    this.term.reset();
    try {
      this.quietUntil = Date.now() + 3000;
      await window.jagents.pty.restart(this.pane.id, this.size());
      fire("terminal-restarted", this.pane.id);
    } catch (error) {
      this.term.write("\r\n\x1b[31m" + String(error.message || error) + "\x1b[0m\r\n");
    }
  }

  showExit(code) {
    this.exitEl.hidden = false;
    this.exitEl.innerHTML = "<span>Process exited" + (code != null ? " with code " + esc(code) : "") + '</span><button class="btn sm secondary" data-restart>' + icon("restart", 14) + "Restart</button>";
  }

  focus() {
    this.term.focus();
  }

  destroy() {
    this.disposed = true;
    clearTimeout(this.refitTimer);
    clearTimeout(this.refitLate);
    clearTimeout(this.webglRetry);
    clearTimeout(this.idleTimer);
    clearTimeout(this.hintTimer);
    views.delete(this.pane.id);
    this.ro.disconnect();
    this.term.dispose();
    this.el.innerHTML = "";
  }
}
