// Dropdown menus, modals, the context-handoff dialog, and the MCP hub panel.

import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, fire, on } from "./store.js";

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
        (it.icon || "") + '<span class="news-menu-text"><span class="news-menu-name" title="' + esc(it.label) + '">' + esc(it.label) + "</span>" + (it.desc ? '<span class="news-menu-desc">' + esc(it.desc) + "</span>" : "") + "</span>" +
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
  // Opens upward from the bottom of the window (the sidebar dock).
  const below = window.innerHeight - r.bottom - 20;
  if ((opts && opts.up) || (below < 240 && r.top > below)) {
    el.style.bottom = window.innerHeight - r.top + 6 + "px";
    el.style.maxHeight = Math.max(200, r.top - 20) + "px";
  } else {
    el.style.top = r.bottom + 6 + "px";
    el.style.maxHeight = Math.max(200, below) + "px";
  }
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

// Settings shows the app's panels (MCP hub, Updates, Plugins, Agents) on its
// page: the next modal() call draws into that element instead of a popup.
let embedHost = null;
export function embedNextModal(el) {
  embedHost = el;
}

export function modal(html, opts) {
  if (embedHost) {
    const host = embedHost;
    embedHost = null;
    host.innerHTML = "";
    const box = document.createElement("div");
    box.className = "modal embedded" + (opts && opts.wide ? " wide" : "");
    box.innerHTML = html;
    host.appendChild(box);
    let done = false;
    const close = () => {
      if (done) return;
      done = true;
      box.remove();
      if (opts && opts.onClose) opts.onClose();
    };
    // Replaced or removed with the page: run the panel's own cleanup.
    const watch = new MutationObserver(() => {
      if (!box.isConnected) {
        watch.disconnect();
        close();
      }
    });
    watch.observe(host, { childList: true });
    box.addEventListener("click", (e) => {
      if (e.target.closest("[data-close]")) e.stopPropagation();
    });
    return { el: box, close, embedded: true };
  }
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
  const agents = (await window.jagents.hub.agents()).filter((a) => a.id !== source.id);
  const terms = store.terminalAgents.filter((t) => (t.id === "claude" || t.id === "codex") && t.available);
  const acps = store.acpAgents.filter((a) => a.available);
  const option = (value, iconHtml, name, desc) =>
    '<label class="choice"><input type="radio" name="target" value="' + esc(value) + '">' + iconHtml + '<span class="choice-text"><span class="choice-name">' + esc(name) + '</span><span class="choice-desc">' + esc(desc) + "</span></span></label>";
  const html =
    '<header class="modal-head">' + icon("handoff", 18) + "<h2>Hand off context from " + esc(source.handle) + '</h2><button class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></header>" +
    '<div class="modal-body">' +
    '<p class="muted small">JAgents packs ' + esc(source.handle) + "'s recent " + (source.kind === "terminal" ? "terminal session" : "messages and tool calls") + " into a handoff file and gives it to the agent you pick, so it can continue the work.</p>" +
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
      const res = await window.jagents.hub.handoff(source.id, opts);
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

// The MCP hub panel: per-launch attach switch, Auto MCP, which agents get the
// server, optional global installs, the tools agents get, and recent activity.
function autoMarkup(auto) {
  if (!auto || !auto.at) return '<p class="muted small">' + (auto && auto.running ? '<span class="spinner"></span> Running…' : "Has not run yet.") + "</p>";
  const when = new Date(auto.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (!auto.changes.length) return '<p class="muted small">Last run ' + esc(when) + ": everything was up to date.</p>";
  return '<div><p class="muted small">Last run ' + esc(when) + ':</p><ul class="auto-changes">' + auto.changes.map((c) => "<li" + (c.error ? ' class="bad"' : "") + "><b>" + esc(c.id) + "</b> " + esc(c.action) + (c.error ? ": " + esc(c.error) : "") + "</li>").join("") + "</ul></div>";
}

// Legacy (development): one button that brings Relay's threads, layout,
// plugins, and MCP setup into JAgents. The data comes in on restart.
function legacyMarkup(l) {
  const d = l.data || {};
  const note = d.status === "error" ? "Import failed: " + d.error : l.imported ? "Imported " + new Date(l.imported.at).toLocaleString() : "";
  const button = l.pending
    ? '<button class="btn sm primary" data-legacy-restart>' + icon("restart", 14) + "Restart to finish import</button>"
    : '<button class="btn sm secondary" data-legacy-import' + (l.root ? "" : ' disabled title="No Relay data on this computer"') + ">" + icon("update", 14) + "Import from legacy Relay</button>";
  return '<h3 class="section-h">Legacy (development)</h3><div class="legacy-row">' + button + (note ? '<span class="muted small">' + esc(note) + "</span>" : "") + "</div>";
}

function supportRows(rows) {
  return rows
    .map(
      (r) =>
        '<div class="install-row">' + harnessIcon(r.id, 18) + '<div class="grow"><div class="install-name">' + esc(r.name) + ' <span class="pill">' + esc(r.where) + "</span>" + (r.mode === "auto" ? ' <span class="pill ok">Automatic</span>' : ' <span class="pill">Global install</span>') + '</div><div class="muted small">' + esc(r.how) + "</div></div>" +
        (r.available ? '<span class="pill ok">Installed</span>' : '<span class="muted small">Not installed</span>') + "</div>",
    )
    .join("");
}

export async function openHubPanel() {
  const info = store.info;
  const render = (d) =>
    '<header class="modal-head">' + icon("hub", 18) + '<h2>MCP hub</h2><span class="pill ok">Running</span><span class="muted small mono">' + esc(d.tools.server) + '</span><span class="spacer"></span><button class="btn sm ghost" data-help-open>' + icon("help", 15) + 'Guide</button><button class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></header>" +
    '<div class="modal-body">' +
    '<div class="setting-row"><div><h3>Connect terminals launched in JAgents</h3><p class="muted small">Adds the <code>jagents</code> MCP server to each Claude Code, Codex, and Devin CLI terminal you start here, for that session only. Their global config is not touched. Terminals pick it up when they start or restart. Chats always get it.</p></div>' +
    '<button class="switch' + (store.info.hubAttach ? " on" : "") + '" role="switch" aria-checked="' + Boolean(store.info.hubAttach) + '" data-attach aria-label="Connect terminals launched in JAgents"></button></div>' +
    '<h3 class="section-h">Auto MCP</h3>' +
    '<div class="setting-row"><div><h3>Keep installs up to date</h3><p class="muted small">At startup and every 10 minutes, fixes global installs that point at an old script.</p></div>' +
    '<button class="switch' + (info.mcpAutoUpdate ? " on" : "") + '" role="switch" aria-checked="' + Boolean(info.mcpAutoUpdate) + '" data-auto="mcp.autoUpdate" aria-label="Keep installs up to date"></button></div>' +
    '<div class="setting-row"><div><h3>Install in every supported agent</h3><p class="muted small">Also adds the server to Claude Code, Codex, Cursor, and Gemini CLI when they are on this computer, so sessions outside JAgents get it too.</p></div>' +
    '<button class="switch' + (info.mcpAutoInstall ? " on" : "") + '" role="switch" aria-checked="' + Boolean(info.mcpAutoInstall) + '" data-auto="mcp.autoInstall" aria-label="Install in every supported agent"></button></div>' +
    '<div class="auto-run">' + autoMarkup(d.auto) + '<button class="btn sm secondary" data-auto-run' + (d.auto && d.auto.running ? " disabled" : "") + ">" + icon("restart", 14) + "Run now</button></div>" +
    '<h3 class="section-h">Agents that get the MCP</h3><div class="install-list">' + supportRows(d.support) + "</div>" +
    '<h3 class="section-h">Install globally <span class="muted small">optional</span></h3>' +
    '<p class="muted small">Writes the jagents server into an agent\'s own config so sessions you start outside JAgents can see JAgents agents too. Remove it here any time.</p>' +
    '<div class="install-list">' +
    d.status
      .map(
        (s) =>
          '<div class="install-row">' + harnessIcon(s.id, 18) + '<div class="grow"><div class="install-name">' + esc(s.name) + (s.installed ? (s.current ? ' <span class="pill ok">Installed</span>' : ' <span class="pill warn">Out of date</span>') : "") + '</div><div class="muted small mono">' + esc(s.where) + "</div>" + (s.error ? '<div class="small" style="color:var(--danger)">' + esc(s.error) + "</div>" : "") + "</div>" +
          (s.installed ? (s.current ? "" : '<button class="btn sm secondary" data-install="' + esc(s.id) + '">Update</button>') + '<button class="btn sm secondary" data-uninstall="' + esc(s.id) + '">Remove</button>' : '<button class="btn sm secondary" data-install="' + esc(s.id) + '"' + (s.available ? "" : ' disabled title="Not installed on this computer"') + ">Install</button>") + "</div>",
      )
      .join("") +
    "</div>" +
    '<h3 class="section-h">Tools agents get</h3><div class="tool-chips">' +
    d.tools.tools.map((t) => '<code class="chip" title="' + esc(t.description) + '">' + esc(t.name) + "</code>").join("") +
    "</div>" +
    '<h3 class="section-h">Activity</h3><div class="activity" data-activity>' + activityMarkup(d.activity) + "</div>" +
    legacyMarkup(d.legacy) +
    '<p class="muted small">Hub files: <span class="mono">' + esc(info.hubDir) + "</span></p>" +
    "</div>";
  const load = async () => {
    const [status, activity, support, auto, tools, legacy] = await Promise.all([window.jagents.hub.mcpStatus(), window.jagents.hub.activity(), window.jagents.hub.support(), window.jagents.hub.autoState(), window.jagents.hub.tools(), window.jagents.legacy.state()]);
    return { status, activity, support, auto, tools, legacy };
  };
  let offAuto = () => {};
  const m = modal(render(await load()), { wide: true, onClose: () => offAuto() });
  const repaint = async () => {
    const body = m.el.querySelector(".modal-body");
    const top = body ? body.scrollTop : 0;
    m.el.innerHTML = render(await load());
    m.el.querySelector(".modal-body").scrollTop = top;
  };
  offAuto = on("app:mcp-auto", () => repaint());
  m.el.addEventListener("click", async (e) => {
    if (e.target.closest("[data-help-open]")) {
      m.close();
      return fire("open-help", "who");
    }
    const getData = e.target.closest("[data-legacy-import]");
    if (getData) {
      getData.disabled = true;
      getData.innerHTML = '<span class="spinner"></span>Importing…';
      try {
        await window.jagents.legacy.importData();
        toast("MCP setup imported. Restart to bring in your threads, layout, and plugins.");
      } catch (error) {
        toast(errorText(error));
      }
      return repaint();
    }
    if (e.target.closest("[data-legacy-restart]")) return window.jagents.updates.restart();
    const attach = e.target.closest("[data-attach]");
    if (attach) {
      store.info.hubAttach = !store.info.hubAttach;
      await window.jagents.setSetting("hub.attach", store.info.hubAttach);
      await window.jagents.setSetting("hub.chosen", true);
      store.info.hubChosen = true;
      fire("hub", store.info);
      toast(store.info.hubAttach ? "New terminals get the jagents MCP server. Restart a terminal to connect it." : "New terminals start without the jagents MCP server.");
      return repaint();
    }
    const auto = e.target.closest("[data-auto]");
    if (auto) {
      const key = auto.dataset.auto;
      const prop = key === "mcp.autoUpdate" ? "mcpAutoUpdate" : "mcpAutoInstall";
      store.info[prop] = !store.info[prop];
      await window.jagents.setSetting(key, store.info[prop]);
      fire("hub", store.info);
      if (store.info[prop]) window.jagents.hub.autoRun().catch((error) => toast(errorText(error)));
      return repaint();
    }
    if (e.target.closest("[data-auto-run]")) {
      e.target.closest("[data-auto-run]").disabled = true;
      try {
        await window.jagents.hub.autoRun();
      } catch (error) {
        toast(errorText(error));
      }
      return repaint();
    }
    const inst = e.target.closest("[data-install]");
    const un = e.target.closest("[data-uninstall]");
    const btn = inst || un;
    if (!btn) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    try {
      if (inst) await window.jagents.hub.install(inst.dataset.install);
      else await window.jagents.hub.uninstall(un.dataset.uninstall);
      toast(inst ? "Installed. New sessions of that agent load the jagents server." : "Removed.");
    } catch (error) {
      toast(errorText(error));
    }
    repaint();
  });
  return m;
}

// Updates: the running version, the latest GitHub release and its notes,
// install (git fast-forward to the release tag), and restart.
function inline(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>");
}

function notesMarkup(text) {
  let html = "";
  let list = false;
  for (const raw of String(text || "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      if (!list) html += "<ul>";
      list = true;
      html += "<li>" + inline(item[1]) + "</li>";
      continue;
    }
    if (list) html += "</ul>";
    list = false;
    if (!line) continue;
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    html += h ? "<h4>" + inline(h[1]) + "</h4>" : "<p>" + inline(line) + "</p>";
  }
  return html + (list ? "</ul>" : "");
}

export async function openUpdatesPanel(checkNow) {
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const render = (u) =>
    '<header class="modal-head">' + icon("update", 18) + "<h2>Updates</h2>" + '<button class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></header>" +
    '<div class="modal-body">' +
    '<div class="version-cards">' +
    '<div class="version-card"><span class="muted small">Running</span><b>v' + esc(u.current) + "</b></div>" +
    '<div class="version-card' + (u.available ? " new" : "") + '"><span class="muted small">Latest release</span><b>' + (u.checking ? '<span class="spinner"></span>' : u.latest ? esc(u.latest) : "None found") + "</b></div>" +
    "</div>" +
    '<p class="muted small">' + (u.repo ? "From github.com/" + esc(u.repo) : "") + (u.checkedAt ? " · checked " + esc(time(u.checkedAt)) : "") + "</p>" +
    (u.error ? '<p class="err-row">' + esc(u.error) + "</p>" : "") +
    (u.applied
      ? '<p class="update-ok">' + icon("check", 15) + "Installed " + esc(u.applied) + ". Restart JAgents to run it.</p>"
      : u.available
        ? '<p class="update-ok">' + icon("update", 15) + esc(u.latest) + (u.applying ? ": " + esc(u.step || "Installing") + "…" : u.asset ? " is ready. Install downloads it from the GitHub release." : " is ready to install.") + "</p>"
        : u.latest && !u.checking && !u.error
          ? '<p class="muted small">You are on the latest version.</p>'
          : "") +
    (u.notes && u.latest ? '<h3 class="section-h">What\'s new in ' + esc(u.latest) + '</h3><div class="release-notes">' + notesMarkup(u.notes) + "</div>" : "") +
    "</div>" +
    '<footer class="modal-foot">' +
    (u.url ? '<button class="btn ghost" data-u="page">' + icon("external", 15) + "Release page</button>" : "") +
    '<span class="spacer"></span>' +
    '<button class="btn secondary" data-u="check"' + (u.checking || u.applying ? " disabled" : "") + ">" + (u.checking ? '<span class="spinner"></span>Checking…' : icon("restart", 15) + "Check now") + "</button>" +
    (u.applied
      ? '<button class="btn primary" data-u="restart">' + icon("restart", 15) + "Restart JAgents</button>"
      : u.available
        ? '<button class="btn primary" data-u="apply"' + (u.applying ? " disabled" : "") + ">" + (u.applying ? '<span class="spinner"></span>' + esc(u.step || "Installing") + "…" : icon("update", 15) + "Install " + esc(u.latest)) + "</button>"
        : "") +
    "</footer>";
  let off = () => {};
  const m = modal(render(await window.jagents.updates.state()), { wide: true, onClose: () => off() });
  off = on("app:update-status", (u) => (m.el.innerHTML = render(u)));
  if (checkNow) window.jagents.updates.check().catch(() => {});
  m.el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-u]");
    if (!b) return;
    const u = await window.jagents.updates.state();
    try {
      if (b.dataset.u === "page") window.open(u.url, "_blank");
      else if (b.dataset.u === "check") await window.jagents.updates.check();
      else if (b.dataset.u === "apply") await window.jagents.updates.apply();
      else if (b.dataset.u === "restart") await window.jagents.updates.restart();
    } catch (error) {
      toast(errorText(error));
    }
  });
  return m;
}

export function updateActivity(list) {
  const box = document.querySelector("[data-activity]");
  if (box) box.innerHTML = activityMarkup(list);
}
