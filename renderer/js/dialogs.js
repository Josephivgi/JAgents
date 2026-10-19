// Dropdown menus, modals, the context-handoff dialog, and the MCP hub panel.

import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, fire } from "./store.js";

let openMenuEl = null;
let overlays = 0;

// Menus and dialogs are DOM; plugin panes that show native views (the browser)
// hide them while one is open so the view does not cover it.
function overlay(delta) {
  overlays = Math.max(0, overlays + delta);
  fire("app:overlay", { open: overlays > 0 });
}

export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
    overlay(-1);
  }
}

document.addEventListener("mousedown", (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest("[data-menu-anchor]")) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

// items: [{label, desc, icon (html), disabled, badge, onPick} | {section: "Label"} | {divider: true}]
export function dropdown(anchor, items, opts) {
  if (openMenuEl && openMenuEl._anchor === anchor) return closeMenu();
  closeMenu();
  const el = document.createElement("div");
  el.className = "news-menu dropdown";
  el.setAttribute("role", "menu");
  el._anchor = anchor;
  el.innerHTML = items
    .map((it, i) => {
      if (it.section) return '<p class="news-menu-label">' + esc(it.section) + "</p>";
      if (it.divider) return '<div class="menu-divider"></div>';
      return (
        '<button type="button" role="menuitem" class="news-menu-row agent-row' + (it.disabled ? " is-missing" : "") + '" data-i="' + i + '"' + (it.disabled ? " disabled" : "") + ">" +
        (it.icon || "") + '<span class="news-menu-text"><span class="news-menu-name">' + esc(it.label) + "</span>" + (it.desc ? '<span class="news-menu-desc">' + esc(it.desc) + "</span>" : "") + "</span>" +
        (it.badge ? '<span class="agent-badge">' + esc(it.badge) + "</span>" : "") + "</button>"
      );
    })
    .join("");
  document.body.appendChild(el);
  const r = anchor.getBoundingClientRect();
  const w = Math.max(260, (opts && opts.width) || 300);
  el.style.width = w + "px";
  const left = Math.min(window.innerWidth - w - 8, (opts && opts.alignRight ? r.right - w : r.left));
  el.style.left = Math.max(8, left) + "px";
  el.style.top = r.bottom + 6 + "px";
  el.style.maxHeight = Math.max(200, window.innerHeight - r.bottom - 20) + "px";
  el.addEventListener("click", (e) => {
    const row = e.target.closest("[data-i]");
    if (!row || row.disabled) return;
    const it = items[Number(row.dataset.i)];
    closeMenu();
    if (it && it.onPick) it.onPick();
  });
  openMenuEl = el;
  overlay(1);
  const first = el.querySelector(".news-menu-row:not(:disabled)");
  if (first) first.focus();
}

export function modal(html, opts) {
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = '<div class="modal' + (opts && opts.wide ? " wide" : "") + '" role="dialog" aria-modal="true">' + html + "</div>";
  document.body.appendChild(back);
  overlay(1);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    overlay(-1);
    back.remove();
    document.removeEventListener("keydown", onKey);
    if (opts && opts.onClose) opts.onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", onKey);
  back.addEventListener("mousedown", (e) => {
    if (e.target === back) close();
  });
  back.addEventListener("click", (e) => {
    if (e.target.closest("[data-close]")) close();
  });
  return { el: back.querySelector(".modal"), close };
}

// Context handoff: pick where the source agent's context goes, add a note.
export async function openHandoff(source, onDone) {
  const agents = (await window.relay.hub.agents()).filter((a) => a.id !== source.id);
  const terms = store.terminalAgents.filter((t) => (t.id === "claude" || t.id === "codex") && t.available);
  const acps = store.acpAgents.filter((a) => a.available);
  const option = (value, iconHtml, name, desc) =>
    '<label class="choice"><input type="radio" name="target" value="' + esc(value) + '">' + iconHtml + '<span class="choice-text"><span class="choice-name">' + esc(name) + '</span><span class="choice-desc">' + esc(desc) + "</span></span></label>";
  const html =
    '<header class="modal-head">' + icon("handoff", 18) + "<h2>Hand off context from " + esc(source.handle) + '</h2><button class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></header>" +
    '<div class="modal-body">' +
    '<p class="muted small">Relay packs ' + esc(source.handle) + "'s recent " + (source.kind === "terminal" ? "terminal session" : "messages and tool calls") + " into a handoff file and gives it to the agent you pick, so it can continue the work.</p>" +
    (agents.length ? '<p class="group-label">Running agents</p><div class="choices">' + agents.map((a) => option("to:" + a.handle, harnessIcon(a.provider, 18), a.handle, a.name + " · " + a.kind)).join("") + "</div>" : "") +
    (terms.length ? '<p class="group-label">New terminal</p><div class="choices">' + terms.map((t) => option("new:" + t.id, harnessIcon(t.id, 18), t.name, "Opens a new terminal with the handoff")).join("") + "</div>" : "") +
    (acps.length ? '<p class="group-label">New chat</p><div class="choices">' + acps.map((a) => option("new:" + a.id, harnessIcon(a.id, 18), a.name, "Opens a new chat with the handoff")).join("") + "</div>" : "") +
    '<label class="field"><span>What should the next agent do? <span class="muted">(optional)</span></span><textarea class="textarea" rows="3" data-note placeholder="e.g. Finish the tests and open a PR"></textarea></label>' +
    "</div>" +
    '<footer class="modal-foot"><button class="btn ghost" data-close>Cancel</button><button class="btn primary" data-go disabled>' + icon("handoff", 16) + "Hand off</button></footer>";
  const m = modal(html, { wide: true });
  const go = m.el.querySelector("[data-go]");
  m.el.addEventListener("change", () => (go.disabled = !m.el.querySelector("input[name=target]:checked")));
  go.addEventListener("click", async () => {
    const picked = m.el.querySelector("input[name=target]:checked").value;
    const note = m.el.querySelector("[data-note]").value;
    const opts = picked.startsWith("to:") ? { to: picked.slice(3), note } : { provider: picked.slice(4), note };
    go.disabled = true;
    go.innerHTML = '<span class="spinner"></span>Handing off…';
    try {
      const res = await window.relay.hub.handoff(source.id, opts);
      m.close();
      toast("Handed off to " + res.to + ".");
      if (onDone) onDone(res);
    } catch (error) {
      go.disabled = false;
      go.innerHTML = icon("handoff", 16) + "Hand off";
      toast(errorText(error));
    }
  });
}

function activityMarkup(list) {
  if (!list.length) return '<p class="muted small">No agent-to-agent activity yet.</p>';
  return list
    .slice()
    .reverse()
    .map((e) => {
      const verb = e.type === "message" ? "→" : e.type === "spawn" ? "spawned" : e.type === "handoff" ? "handed off to" : e.type;
      return '<div class="act-row"><span class="act-time">' + new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + '</span><span class="act-main"><b>' + esc(e.from) + "</b> " + esc(verb) + " <b>" + esc(e.to) + "</b>" + (e.text ? '<span class="act-text">' + esc(e.text.slice(0, 160)) + "</span>" : "") + "</span></div>";
    })
    .join("");
}

// The MCP hub panel: per-launch attach switch, optional global installs, the
// tools agents get, and recent agent-to-agent activity.
export async function openHubPanel() {
  const info = store.info;
  const render = (status, activity) =>
    '<header class="modal-head">' + icon("hub", 18) + '<h2>MCP hub</h2><span class="pill ok">Running</span><button class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></header>" +
    '<div class="modal-body">' +
    '<div class="setting-row"><div><h3>Connect agents launched in Relay</h3><p class="muted small">Adds the <code>relay</code> MCP server to each Claude Code and Codex terminal and each chat you start here, for that session only. Their global config is not touched. Terminals pick it up when they start or restart.</p></div>' +
    '<button class="switch' + (store.info.hubAttach ? " on" : "") + '" role="switch" aria-checked="' + Boolean(store.info.hubAttach) + '" data-attach aria-label="Connect agents launched in Relay"></button></div>' +
    '<h3 class="section-h">Install globally <span class="muted small">optional</span></h3>' +
    '<p class="muted small">Writes the relay server into an agent\'s own config so sessions you start outside Relay can see Relay agents too. Remove it here any time.</p>' +
    '<div class="install-list">' +
    status
      .map(
        (s) =>
          '<div class="install-row">' + harnessIcon(s.id === "claude" ? "claude" : s.id, 18) + '<div class="grow"><div class="install-name">' + esc(s.name) + (s.installed ? ' <span class="pill ok">Installed</span>' : "") + '</div><div class="muted small mono">' + esc(s.where) + "</div>" + (s.error ? '<div class="small" style="color:var(--danger)">' + esc(s.error) + "</div>" : "") + "</div>" +
          (s.installed ? '<button class="btn sm secondary" data-uninstall="' + esc(s.id) + '">Remove</button>' : '<button class="btn sm secondary" data-install="' + esc(s.id) + '"' + (s.available ? "" : ' disabled title="Not installed on this computer"') + ">Install</button>") + "</div>",
      )
      .join("") +
    "</div>" +
    '<h3 class="section-h">Tools agents get</h3><div class="tool-chips">' +
    ["whoami", "list_agents", "send_message", "read_agent", "list_providers", "spawn_subagent", "wait_for_agent", "stop_agent", "handoff_context"].map((t) => '<code class="chip">' + t + "</code>").join("") +
    "</div>" +
    '<h3 class="section-h">Activity</h3><div class="activity" data-activity>' + activityMarkup(activity) + "</div>" +
    '<p class="muted small">Hub files: <span class="mono">' + esc(info.hubDir) + "</span></p>" +
    "</div>";
  const [status, activity] = await Promise.all([window.relay.hub.mcpStatus(), window.relay.hub.activity()]);
  const m = modal(render(status, activity), { wide: true });
  const repaint = async () => {
    const [s2, a2] = await Promise.all([window.relay.hub.mcpStatus(), window.relay.hub.activity()]);
    m.el.innerHTML = render(s2, a2);
  };
  m.el.addEventListener("click", async (e) => {
    const attach = e.target.closest("[data-attach]");
    if (attach) {
      store.info.hubAttach = !store.info.hubAttach;
      await window.relay.setSetting("hub.attach", store.info.hubAttach);
      await window.relay.setSetting("hub.chosen", true);
      store.info.hubChosen = true;
      fire("hub", store.info);
      toast(store.info.hubAttach ? "New agents get the relay MCP server. Restart a terminal to connect it." : "New agents start without the relay MCP server.");
      return repaint();
    }
    const inst = e.target.closest("[data-install]");
    const un = e.target.closest("[data-uninstall]");
    const btn = inst || un;
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      if (inst) await window.relay.hub.install(inst.dataset.install);
      else await window.relay.hub.uninstall(un.dataset.uninstall);
      toast(inst ? "Installed. New sessions of that agent load the relay server." : "Removed.");
    } catch (error) {
      toast(errorText(error));
    }
    repaint();
  });
  return m;
}

export function updateActivity(list) {
  const box = document.querySelector("[data-activity]");
  if (box) box.innerHTML = activityMarkup(list);
}
