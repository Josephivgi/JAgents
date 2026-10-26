// A terminal pane: xterm.js in the renderer, attached to a node-pty process in
// the main process. The process outlives the view, so moving a pane between
// layouts or reloading the window reattaches and replays the screen.

import { esc } from "./util.js";
import { icon } from "./icons.js";
import { on, fire, store } from "./store.js";
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
  if (v) v.term.write(data);
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
