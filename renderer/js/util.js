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

let toastTimer = 0;
export function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = String(message || "");
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
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
