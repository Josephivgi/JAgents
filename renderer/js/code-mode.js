// Code mode: terminals and chats split evenly. Grid packs N panes into
// ceil(sqrt(N)) columns with every row sharing its width equally; Columns and
// Rows put them all side by side or stacked. Pane views live as long as their
// pane does, and layout changes only move their elements.

import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, fire, on } from "./store.js";
import { TerminalView } from "./terminal-view.js";
import { ChatView, statusLabel } from "./chat-view.js";
import { openHandoff } from "./dialogs.js";
import { PluginPaneView, pluginKindIcon, openPluginsFromPane } from "./plugins.js";

const lastData = new Map(); // terminal paneId -> ms of last output
const panes = new Map(); // paneId -> {pane, el, view, snap}
let root = null;
let gridEl = null;
let layout = "grid";
let maximized = "";
let dragId = "";

export function notePtyData(id) {
  lastData.set(id, Date.now());
}

export function setLayout(next) {
  layout = next;
  window.relay.setSetting("layout", next);
  arrange();
}

export function getLayout() {
  return layout;
}

function chunk(list, cols) {
  const out = [];
  for (let i = 0; i < list.length; i += cols) out.push(list.slice(i, i + cols));
  return out;
}

function columnsFor(n) {
  if (n <= 1) return 1;
  const w = gridEl ? gridEl.clientWidth : 1200;
  const h = gridEl ? gridEl.clientHeight : 800;
  // Wide windows keep 2 and 3 panes side by side; past that, a square-ish grid.
  if (n <= 3 && w / Math.max(1, h) > 1.25) return n;
  return Math.ceil(Math.sqrt(n));
}

function arrange() {
  if (!gridEl) return;
  const order = store.panes.map((p) => p.id).filter((id) => panes.has(id));
  const shown = maximized && panes.has(maximized) ? [maximized] : order;
  let groups;
  if (layout === "columns") groups = [shown];
  else if (layout === "rows") groups = shown.map((id) => [id]);
  else groups = chunk(shown, columnsFor(shown.length));
  root.querySelector(".code-empty").hidden = order.length > 0;
  gridEl.hidden = order.length === 0;
  for (const p of panes.values()) p.el.classList.toggle("is-max", p.pane.id === maximized);
  // Moving elements is only needed when the arrangement itself changed.
  const sig = layout + "|" + order.join(",") + "|" + groups.map((g) => g.join(",")).join("/");
  if (sig === gridEl._sig) return;
  gridEl._sig = sig;
  // Park every pane, then rebuild rows and move pane elements into them.
  const park = document.createDocumentFragment();
  for (const { el } of panes.values()) park.appendChild(el);
  gridEl.innerHTML = "";
  gridEl.dataset.layout = layout;
  for (const g of groups) {
    const row = document.createElement("div");
    row.className = "grid-row";
    for (const id of g) row.appendChild(panes.get(id).el);
    gridEl.appendChild(row);
  }
  fire("app:layout");
  const hidden = document.createElement("div");
  hidden.hidden = true;
  hidden.className = "parked";
  hidden.appendChild(park);
  gridEl.appendChild(hidden);
}

function headMarkup(entry) {
  const p = entry.pane;
  const parent = p.parentId ? store.hubAgents.find((a) => a.id === p.parentId) : null;
  if (p.kind === "plugin")
    return (
      '<span class="pane-ic">' + pluginKindIcon(p.pluginKind, 15) + "</span>" +
      '<span class="pane-title" title="' + esc(p.title) + '">' + esc(p.title || p.name) + "</span>" +
      '<span class="spacer"></span>' +
      '<button class="icon-btn" data-act="max" title="' + (maximized === p.id ? "Restore split" : "Maximize") + '">' + icon(maximized === p.id ? "minimize" : "maximize", 15) + "</button>" +
      '<button class="icon-btn" data-act="close" title="Close pane">' + icon("close", 15) + "</button>"
    );
  const st = paneStatus(entry);
  return (
    '<span class="pane-ic">' + harnessIcon(p.provider, 15) + "</span>" +
    '<span class="pane-handle">' + esc(p.handle || "") + "</span>" +
    '<span class="pane-title" title="' + esc(p.title) + '">' + esc(p.kind === "terminal" ? p.name : p.title || p.name) + "</span>" +
    (parent ? '<span class="chip sub" title="Subagent of ' + esc(parent.handle) + '">' + icon("subagent", 11) + esc(parent.handle) + "</span>" : "") +
    (p.kind === "terminal" && p.attached ? '<span class="chip hub" title="Connected to the Relay MCP hub">' + icon("hub", 11) + "MCP</span>" : "") +
    '<span class="status-dot ' + st.tone + '" title="' + esc(st.text) + '"></span><span class="pane-status">' + esc(st.text) + "</span>" +
    '<span class="spacer"></span>' +
    '<button class="icon-btn" data-act="handoff" title="Hand off context">' + icon("handoff", 15) + "</button>" +
    (p.kind === "terminal" ? '<button class="icon-btn" data-act="restart" title="Restart">' + icon("restart", 15) + "</button>" : "") +
    '<button class="icon-btn" data-act="max" title="' + (maximized === p.id ? "Restore split" : "Maximize") + '">' + icon(maximized === p.id ? "minimize" : "maximize", 15) + "</button>" +
    '<button class="icon-btn" data-act="close" title="Close pane">' + icon("close", 15) + "</button>"
  );
}

function paneStatus(entry) {
  if (entry.pane.kind === "chat") return statusLabel(entry.snap);
  if (entry.exited) return { text: "Exited", tone: "error" };
  const t = lastData.get(entry.pane.id) || 0;
  return Date.now() - t < 1500 ? { text: "Working", tone: "busy" } : { text: "Idle", tone: "ok" };
}

function paintHead(entry) {
  const head = entry.el.querySelector(".pane-head");
  const html = headMarkup(entry);
  if (head._html !== html) {
    head._html = html;
    head.innerHTML = html;
  }
}

function mount(pane) {
  const el = document.createElement("section");
  el.className = "pane " + pane.kind;
  el.dataset.pane = pane.id;
  el.innerHTML = '<header class="pane-head" draggable="true"></header><div class="pane-body"></div>';
  const entry = { pane, el, view: null, snap: null, exited: false };
  panes.set(pane.id, entry);
  const body = el.querySelector(".pane-body");
  if (pane.kind === "terminal") entry.view = new TerminalView(body, pane);
  else if (pane.kind === "plugin") entry.view = new PluginPaneView(body, pane);
  else
    entry.view = new ChatView(body, {
      chatId: pane.chatId,
      compact: true,
      placeholder: "Message " + (pane.handle || "the agent"),
      onChange: (snap) => {
        entry.snap = snap;
        paintHead(entry);
      },
    });
  paintHead(entry);
  el.addEventListener("click", (e) => {
    if (openPluginsFromPane(e)) return;
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === "close") return closePane(pane.id);
    if (act === "max") {
      maximized = maximized === pane.id ? "" : pane.id;
      arrange();
      for (const p of panes.values()) paintHead(p);
      fire("app:layout");
      return;
    }
    if (act === "restart" && entry.view && entry.view.restart) return entry.view.restart();
    if (act === "handoff") return openHandoff(agentFor(entry), (res) => res && res.started && setTimeout(() => focusAgent(res.to), 300));
  });
  el.addEventListener("mousedown", () => setActive(pane.id));
  const head = el.querySelector(".pane-head");
  head.addEventListener("dragstart", (e) => {
    if (e.target.closest("button")) return e.preventDefault();
    dragId = pane.id;
    e.dataTransfer.effectAllowed = "move";
    el.classList.add("dragging");
  });
  head.addEventListener("dragend", () => {
    dragId = "";
    el.classList.remove("dragging");
    for (const p of panes.values()) p.el.classList.remove("drop-target");
  });
  el.addEventListener("dragover", (e) => {
    if (!dragId || dragId === pane.id) return;
    e.preventDefault();
    el.classList.add("drop-target");
  });
  el.addEventListener("dragleave", () => el.classList.remove("drop-target"));
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    el.classList.remove("drop-target");
    if (!dragId || dragId === pane.id) return;
    const ids = store.panes.map((p) => p.id);
    const a = ids.indexOf(dragId);
    const b = ids.indexOf(pane.id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    store.panes.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id));
    window.relay.panes.reorder(ids);
    arrange();
  });
  return entry;
}

function agentFor(entry) {
  const p = entry.pane;
  return { id: p.kind === "chat" ? p.chatId : p.id, handle: p.handle, kind: p.kind, provider: p.provider, name: p.name };
}

function setActive(id) {
  for (const p of panes.values()) p.el.classList.toggle("active", p.pane.id === id);
}

async function closePane(id) {
  try {
    const ok = await window.relay.panes.remove(id);
    if (ok === false) return;
  } catch (error) {
    toast(errorText(error));
  }
}

export function syncPanes(list) {
  store.panes = list;
  const ids = new Set(list.map((p) => p.id));
  for (const [id, entry] of panes) {
    if (!ids.has(id)) {
      entry.view.destroy();
      entry.el.remove();
      panes.delete(id);
      if (maximized === id) maximized = "";
    }
  }
  for (const p of list) {
    const entry = panes.get(p.id) || mount(p);
    entry.pane = Object.assign(entry.pane, p);
    paintHead(entry);
  }
  arrange();
  fire("panes", list);
}

export function markExited(id) {
  const e = panes.get(id);
  if (e) {
    e.exited = true;
    paintHead(e);
  }
}

export function focusAgent(ref) {
  const entry = Array.from(panes.values()).find((e) => e.pane.handle === ref || e.pane.id === ref || e.pane.chatId === ref);
  if (!entry) return false;
  if (maximized && maximized !== entry.pane.id) {
    maximized = "";
    arrange();
  }
  setActive(entry.pane.id);
  entry.el.classList.remove("flash");
  void entry.el.offsetWidth;
  entry.el.classList.add("flash");
  if (entry.view && entry.view.focus) entry.view.focus();
  return true;
}

export async function addTerminal(provider) {
  try {
    const pane = await window.relay.panes.addTerminal({ provider });
    setTimeout(() => focusAgent(pane.id), 200);
  } catch (error) {
    toast(errorText(error));
  }
}

export async function addChat(harnessId, chatId) {
  try {
    const pane = await window.relay.panes.addChat(chatId ? { chatId } : { harnessId });
    setTimeout(() => focusAgent(pane.id), 200);
    return pane;
  } catch (error) {
    toast(errorText(error));
  }
}

export function onRelayout() {
  arrange();
}

export function renderCodeMode(el) {
  root = el;
  layout = store.info.layout || "grid";
  const termCards = [
    ["claude", "Claude Code", "claude in a terminal"],
    ["codex", "Codex", "codex in a terminal"],
  ];
  el.innerHTML =
    '<div class="hub-banner" data-hub-banner hidden></div>' +
    '<div class="grid" data-grid></div>' +
    '<div class="code-empty" hidden><div class="empty-inner">' +
    "<h1>Start your agents</h1>" +
    '<p class="muted">Terminals run the real Claude Code and Codex CLIs. Chats run Claude Code natively through the Agent SDK, or ACP agents like Devin and Cursor. Everything you open splits the screen evenly; add more with +.</p>' +
    '<div class="start-cards">' +
    '<button class="start-card featured" data-start="split">' + harnessIcon("claude", 22) + harnessIcon("codex", 22) + '<span class="sc-name">Claude Code + Codex</span><span class="sc-desc">Two terminals, side by side</span></button>' +
    termCards.map(([id, name, desc]) => '<button class="start-card" data-start="term:' + id + '">' + harnessIcon(id, 22) + '<span class="sc-name">' + name + '</span><span class="sc-desc">' + desc + "</span></button>").join("") +
    '<button class="start-card" data-start="chat:claude-code">' + harnessIcon("claude-code", 22) + '<span class="sc-name">Claude Code chat</span><span class="sc-desc">Native, through the Agent SDK</span></button>' +
    '<button class="start-card" data-start="chat">' + harnessIcon("devin", 22) + '<span class="sc-name">ACP chat</span><span class="sc-desc">Devin, Cursor, Gemini…</span></button>' +
    "</div></div></div>";
  gridEl = el.querySelector("[data-grid]");
  el.addEventListener("click", async (e) => {
    const start = e.target.closest("[data-start]");
    if (!start) return;
    const v = start.dataset.start;
    if (v === "split") {
      await addTerminal("claude");
      await addTerminal("codex");
    } else if (v.startsWith("term:")) addTerminal(v.slice(5));
    else if (v.startsWith("chat:")) addChat(v.slice(5));
    else if (v === "chat") {
      const first = store.acpAgents.find((a) => a.available && !a.native);
      if (!first) return toast("No ACP agent is installed. Install Devin or the Cursor CLI.");
      addChat(first.id);
    }
  });
  new ResizeObserver(() => arrange()).observe(gridEl);
  setInterval(() => {
    for (const entry of panes.values()) if (entry.pane.kind === "terminal") paintHead(entry);
  }, 1000);
  on("hub-agents", () => {
    for (const entry of panes.values()) paintHead(entry);
  });
  on("plugin-kinds", () => {
    for (const entry of panes.values()) if (entry.pane.kind === "plugin") paintHead(entry);
  });
}
