export function esc(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const paths = {
  build: '<path d="M4 4h16v12H8l-4 4z"/>',
  plugins: '<path d="M9 3v4M15 3v4M6 7h12v5a6 6 0 0 1-12 0zM12 18v3"/>',
  agents: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  reload: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  wrench: '<path d="M14 6a4 4 0 0 0 5 5l-9 9-3-3 9-9a4 4 0 0 1-2-2z"/>',
  logs: '<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
};

export function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (paths[name] || "") + "</svg>";
}

// JAgents' own dialogs, menus, toasts and Settings draw in the browser's top
// layer, above any z-index a plugin gives its own elements. The last one
// shown is on top, so a menu opened in a dialog shows over the dialog.
export function toTopLayer(el) {
  if (!el || typeof el.showPopover !== "function") return;
  if (!el.hasAttribute("popover")) el.setAttribute("popover", "manual");
  if (el.matches(":popover-open")) el.hidePopover();
  if (el.isConnected) el.showPopover();
}

export function leaveTopLayer(el) {
  if (el && el.hasAttribute("popover") && el.matches(":popover-open")) el.hidePopover();
}

let toastTimer = 0;
export function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = String(message || "");
  toTopLayer(el);
  // Toasts sit over the sidebar, just above the dock: native views (browser,
  // plugin views) never go there, so they cannot cover the message. What
  // stacks on the dock (the update card, a menu opened from the dock) stays
  // clear too: the toast goes above the highest of them. A menu from the dock
  // that leaves no room above it keeps the toast clear sideways instead: the
  // toast ends left of the menu when that leaves it room to read.
  el.style.bottom = "";
  el.style.maxWidth = "";
  el.classList.add("show");
  const side = document.querySelector(".sidebar");
  const s = side && side.getBoundingClientRect();
  const band = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--strip-h")) || 38;
  const tall = el.offsetHeight;
  let top = Infinity;
  const beside = [];
  for (const n of document.querySelectorAll(".sidebar > .side-dock, .sidebar > .update-pop, .news-menu.dropdown")) {
    const r = n.getBoundingClientRect();
    if (!r.height || (s && (r.left >= s.right || r.right <= s.left))) continue;
    // A menu counts when it opens upward (from the dock), not one higher up.
    if (n.classList.contains("dropdown")) {
      if (!n.style.bottom) continue;
      if (r.top - 8 - tall < band) {
        beside.push(r);
        continue;
      }
    }
    top = Math.min(top, r.top);
  }
  el.style.bottom = top < Infinity ? Math.max(8, Math.round(window.innerHeight - top + 8)) + "px" : "";
  for (const r of beside) {
    const t = el.getBoundingClientRect();
    if (t.right <= r.left || t.left >= r.right || t.bottom <= r.top || t.top >= r.bottom) continue;
    const room = Math.floor(r.left - 8 - t.left);
    if (room >= 96) el.style.maxWidth = room + "px";
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    leaveTopLayer(el);
  }, 3200);
}

export function errorText(error) {
  return String((error && error.message) || error || "Something went wrong.").replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

export function monogram(name) {
  const words = String(name || "?").trim().split(/\s+/);
  return esc((words[0][0] || "?") + (words[1] ? words[1][0] : ""));
}

// Agent replies as markdown (parser, highlighting, sanitizer): chat-markdown.js.
export { markdown } from "./chat-markdown.js";
