// A terminal pane: xterm.js in the renderer, attached to a node-pty process in
// the main process. The process outlives the view, so moving a pane between
// layouts or reloading the window reattaches and replays the screen.

import { esc } from "./util.js";
import { icon } from "./icons.js";
import { on, fire, store } from "./store.js";

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
  if (v) v.term.write(data);
}

export function routePtyExit({ id, exitCode }) {
  const v = views.get(id);
  if (v) v.showExit(exitCode);
}

function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

// All 16 ANSI colors: the bright ones used to fall back to xterm's defaults,
// which clashed with the rest of the palette.
function xtermTheme() {
  return isDark()
    ? { background: "#15171c", foreground: "#e3e5ea", cursor: "#c7b8ff", cursorAccent: "#15171c", selectionBackground: "#4b4370", black: "#1d2027", brightBlack: "#5c6370", red: "#ef7d7d", brightRed: "#ff9b9b", green: "#7fd1a0", brightGreen: "#9be6b8", yellow: "#e8c46e", brightYellow: "#f5d78e", blue: "#82aaff", brightBlue: "#a3c1ff", magenta: "#c89cff", brightMagenta: "#dab8ff", cyan: "#7fd6e0", brightCyan: "#a2e6ee", white: "#d8dbe2", brightWhite: "#ffffff" }
    : { background: "#fbfbfd", foreground: "#2a2d36", cursor: "#5b4bc4", cursorAccent: "#fbfbfd", selectionBackground: "#d9d3fb", black: "#2a2d36", brightBlack: "#7a7f8c", red: "#c43d3d", brightRed: "#d65454", green: "#2f8a55", brightGreen: "#3b9e66", yellow: "#a87412", brightYellow: "#b8862a", blue: "#3463c4", brightBlue: "#4a78d6", magenta: "#8a44c4", brightMagenta: "#9c5ad4", cyan: "#1f8a99", brightCyan: "#2a9dad", white: "#d0d3da", brightWhite: "#ffffff" };
}

// Agent CLIs pick colors for a dark terminal; in the light theme xterm nudges
// text too faint to read against the background.
function contrast() {
  return isDark() ? 1 : 4.5;
}

export function retheme() {
  for (const v of views.values()) {
    v.term.options.theme = xtermTheme();
    v.term.options.minimumContrastRatio = contrast();
  }
}

// Cascadia Mono has no coding ligatures, which merge "->" and the like in a
// terminal grid.
const TERM_FONT = '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace';
let fontReady = null;

// xterm measures the cell once. Measured before the font is loaded it gets a
// fallback font's cell, and text overlaps or gaps until the next resize.
function loadTermFont() {
  if (!fontReady) {
    const load = Promise.all([document.fonts.load('13px "Cascadia Mono"'), document.fonts.load('bold 13px "Cascadia Mono"')]).catch(() => {});
    fontReady = Promise.race([load, new Promise((r) => setTimeout(r, 1500))]);
  }
  return fontReady;
}

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
    this.el.innerHTML = '<div class="xterm-host"></div><div class="term-exit" hidden></div>';
    this.host = this.el.querySelector(".xterm-host");
    this.exitEl = this.el.querySelector(".term-exit");
    const info = store.info || {};
    this.term = new window.Terminal({
      fontFamily: TERM_FONT,
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 8000,
      theme: xtermTheme(),
      minimumContrastRatio: contrast(),
      // Wide symbols (⏺, ✻) are drawn inside their cell instead of over the next.
      rescaleOverlappingGlyphs: true,
      // ConPTY repaints the screen itself after a resize; without this xterm
      // reflows the lines too and they come out doubled or cut.
      windowsPty: info.platform === "win32" ? { backend: "conpty", buildNumber: info.osBuild || undefined } : undefined,
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    if (window.Unicode11Addon) {
      // Emoji and symbol widths as agent CLIs count them, so columns line up.
      this.term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      this.term.unicode.activeVersion = "11";
    }
    this.term.onData((data) => window.jagents.pty.write(pane.id, data));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "c" && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        // No text on the clipboard (a screenshot): pass Ctrl+V on so the agent
        // can read the image itself.
        const passOn = () => window.jagents.pty.write(pane.id, "\x16");
        navigator.clipboard.readText().then((t) => (t ? this.term.paste(t) : passOn()), passOn);
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
    loadTermFont().then(() => {
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
    if (this.attached) window.jagents.pty.resize(this.pane.id, s.cols, s.rows);
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
    views.delete(this.pane.id);
    this.ro.disconnect();
    this.term.dispose();
    this.el.innerHTML = "";
  }
}
