// A terminal pane: xterm.js in the renderer, attached to a node-pty process in
// the main process. The process outlives the view, so moving a pane between
// layouts or reloading the window reattaches and replays the screen.

import { esc } from "./util.js";
import { icon } from "./icons.js";
import { on } from "./store.js";

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
  if (!document.hidden) refitAll();
});

export function routePtyData({ id, data }) {
  const v = views.get(id);
  if (v) v.term.write(data);
}

export function routePtyExit({ id, exitCode }) {
  const v = views.get(id);
  if (v) v.showExit(exitCode);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function xtermTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  return dark
    ? { background: "#15171c", foreground: "#e3e5ea", cursor: "#c7b8ff", cursorAccent: "#15171c", selectionBackground: "#4b4370", black: "#1d2027", brightBlack: "#5c6370", red: "#ef7d7d", green: "#7fd1a0", yellow: "#e8c46e", blue: "#82aaff", magenta: "#c89cff", cyan: "#7fd6e0", white: "#d8dbe2", brightWhite: "#ffffff" }
    : { background: "#fbfbfd", foreground: "#2a2d36", cursor: "#5b4bc4", cursorAccent: "#fbfbfd", selectionBackground: "#d9d3fb", black: "#2a2d36", brightBlack: "#7a7f8c", red: "#c43d3d", green: "#2f8a55", yellow: "#a87412", blue: "#3463c4", magenta: "#8a44c4", cyan: "#1f8a99", white: "#d0d3da", brightWhite: "#ffffff" };
}

export function retheme() {
  for (const v of views.values()) v.term.options.theme = xtermTheme();
}

export class TerminalView {
  constructor(el, pane) {
    this.el = el;
    this.pane = pane;
    this.el.classList.add("termview");
    this.el.innerHTML = '<div class="xterm-host"></div><div class="term-exit" hidden></div>';
    this.host = this.el.querySelector(".xterm-host");
    this.exitEl = this.el.querySelector(".term-exit");
    this.term = new window.Terminal({
      fontFamily: cssVar("--mono") || "Cascadia Code, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 8000,
      theme: xtermTheme(),
    });
    this.fit = new window.FitAddon.FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(this.host);
    this.term.onData((data) => window.jagents.pty.write(pane.id, data));
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "c" && this.term.hasSelection()) {
        navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
        return false;
      }
      if (mod && e.key.toLowerCase() === "v") {
        e.preventDefault();
        navigator.clipboard.readText().then((t) => t && this.term.paste(t));
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
    this.attach();
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
    if (!this.host.offsetWidth || !this.host.offsetHeight) return;
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
    clearTimeout(this.refitTimer);
    clearTimeout(this.refitLate);
    views.delete(this.pane.id);
    this.ro.disconnect();
    this.term.dispose();
    this.el.innerHTML = "";
  }
}
