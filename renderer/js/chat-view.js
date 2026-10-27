// A chat thread: transcript plus the docked composer card. The composer takes
// text and attachments (paste, drop, or the paperclip), and one picker chooses
// the agent and its model: agent logos across the top, that agent's models
// below. Picking another agent on a bound chat hands the chat over. Code mode
// shows several of these at once and Thread mode shows one large.
//
// The transcript is patched row by row (each row has an id), so streaming
// text does not rebuild the page: selections and open Thinking rows stay put.
// Tool calls the chat's permission mode does not answer by itself wait as
// approval cards with the agent's own options. Messages sent mid-turn wait as
// queue cards above the composer.

import { esc, toast, errorText } from "./util.js";
import { markdown } from "./chat-markdown.js";
import { harnessIcon, icon } from "./icons.js";
import { store, on, fire, refreshModelInfo, mergeModelInfo, refreshChats } from "./store.js";
import { openMarketplace } from "./marketplace.js";
import { toolLabel, toolBody, toolStatusIcon, groupable, groupLabel, groupIcon, turnRollup, diffCard } from "./chat-tools.js";

const views = new Set();

// Last known state of every chat, for subagent cards in their parent's chat.
const chatStates = new Map();

export function routeAcpState(snap) {
  if (snap.models && snap.models.availableModels.length) {
    store.modelCache[snap.harnessId] = Object.assign({ preferred: "" }, store.modelCache[snap.harnessId], { models: snap.models });
  }
  const prev = chatStates.get(snap.chatId);
  const next = { chatId: snap.chatId, status: snap.status, title: snap.title, handle: snap.handle, harnessId: snap.harnessId, parentId: snap.parentId, agentName: snap.agentName };
  chatStates.set(snap.chatId, next);
  for (const v of views) if (v.chatId === snap.chatId) v.setSnap(snap);
  // A subagent's status or title changed: its parent's card shows it.
  if (snap.parentId && (!prev || prev.status !== next.status || prev.title !== next.title)) {
    for (const v of views) if (v.chatId === snap.parentId) v.paint();
  }
}

// Permission modes, as the composer's picker shows them.
const PERM_MODES = [
  { value: "ask", name: "Ask", desc: "Asks before each tool call the agent wants approved." },
  { value: "edits", name: "Accept edits", desc: "Reads, edits and searches without asking. Asks before commands." },
  { value: "auto", name: "Auto", desc: "Allows each tool call once, without asking." },
  { value: "full", name: "Full access", desc: "Allows everything and tells the agent not to ask." },
];

// A chat counts as watched when the window has focus and the chat is on screen.
function watched(chatId) {
  if (!document.hasFocus()) return false;
  for (const v of views) if (v.chatId === chatId && v.el.offsetParent !== null) return true;
  return false;
}

// A system notification when a turn ends or needs approval in a chat nobody is
// looking at. Clicking it opens that chat.
on("app:acp-attention", (a) => {
  if (!a || !a.chatId || watched(a.chatId)) return;
  const state = chatStates.get(a.chatId) || (store.chats || []).find((c) => c.id === a.chatId) || {};
  // Subagents finish all the time; their parent gets the reply.
  if (a.kind !== "permission" && state.parentId) return;
  const who = a.agentName || "The agent";
  const title = a.kind === "permission" ? who + " needs your approval" : a.kind === "error" ? who + " stopped with an error" : who + " finished";
  const body = a.kind === "permission" ? a.title || "" : state.title || a.title || "";
  try {
    const n = new Notification(title, { body, silent: false });
    n.onclick = () => {
      window.focus();
      fire("open-chat", a.chatId);
    };
  } catch {
    /* notifications unavailable */
  }
});

on("chats", () => {
  for (const v of views) if (v.chatId) v.paint();
});

// Subagents from the subagents plugin (handles like claude-code-3/devin-1),
// for the live cards in their parent's chat. The plugin says when they change.
let pluginSubs = [];
let subsTimer = 0;
async function refreshSubagents() {
  try {
    const st = await window.jagents.plugins.invoke("subagents", "state");
    pluginSubs = (st && st.subagents) || [];
  } catch {
    pluginSubs = [];
  }
  for (const v of views) {
    if (v.subOpen) v.loadSub();
    else if (v.chatId) v.paint();
  }
}
on("app:plugin-message", (m) => {
  if (!m || m.id !== "subagents") return;
  clearTimeout(subsTimer);
  subsTimer = setTimeout(refreshSubagents, 150);
});
setTimeout(refreshSubagents, 500);

// Ctrl+F finds in the chat that has focus, or the one last used.
let lastView = null;
document.addEventListener("keydown", (event) => {
  if (!((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "f")) return;
  const active = document.activeElement;
  let view = null;
  for (const v of views) if (v.el.contains(active)) view = v;
  if (!view && lastView && views.has(lastView) && lastView.el.offsetParent !== null) view = lastView;
  if (!view) for (const v of views) if (v.el.offsetParent !== null) view = view || v;
  if (!view) return;
  event.preventDefault();
  view.openFind();
});

export function routeAcpModels(info) {
  if (!info || !info.harnessId) return;
  mergeModelInfo(info.harnessId, info);
  for (const v of views) if (v.currentAgentId() === info.harnessId || v.viewHarness === info.harnessId) v.onModels();
}

on("models", (id) => {
  for (const v of views) if (v.currentAgentId() === id || v.viewHarness === id) v.onModels();
});
on("agents", () => {
  for (const v of views) v.paintToggles();
});

const CHECK = '<svg class="ai-harness-check" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6"/></svg>';

// Agents whose effort levels were asked for this session.
const effortAsked = new Set();

// Effort levels as people read them; agents send ids like xhigh or "Thinking: max".
const EFFORT_NAMES = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", off: "Off" };
function effortName(value, name) {
  if (EFFORT_NAMES[value]) return EFFORT_NAMES[value];
  const n = String(name || value).replace(/^(thinking|effort|reasoning)\s*:\s*/i, "");
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function searchMarkup(what) {
  return '<div class="menu-search">' + icon("search", 14) + '<input type="text" data-menu-search autocomplete="off" spellcheck="false" placeholder="Search ' + what + '…" aria-label="Search ' + what + '"></div>';
}

function applyFilter(menu, query) {
  const needle = query.trim().toLowerCase();
  let shown = 0;
  for (const row of menu.querySelectorAll("[data-menu-text]")) {
    const hit = !needle || row.dataset.menuText.includes(needle);
    row.hidden = !hit;
    if (hit) shown++;
  }
  const none = menu.querySelector("[data-menu-nomatch]");
  if (none) none.hidden = shown > 0 || !needle;
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

const FIELD_SIZING = typeof CSS !== "undefined" && CSS.supports && CSS.supports("field-sizing", "content");
function autoGrow(el) {
  if (FIELD_SIZING) return;
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 200) + "px";
}

const ATTACH_MAX = 10;
const ATTACH_BYTES = 50 * 1024 * 1024;
const PREVIEW_BYTES = 10 * 1024 * 1024;
const IMAGE_RE = /^image\/(png|jpeg|webp|gif)$/;

function fileSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + " MB";
}

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error || new Error("Could not read " + file.name));
    r.readAsDataURL(file);
  });
}

// Saved attachments are served by the app at attachments/<chatId>/<file>.
function attachmentUrl(chatId, a) {
  if (a.preview) return a.preview;
  if (!chatId || !a.path) return "";
  const base = String(a.path).split(/[\\/]/).pop();
  return "attachments/" + encodeURIComponent(chatId) + "/" + encodeURIComponent(base);
}

function attachmentMarkup(chatId, a) {
  const name = esc(a.name || "file");
  const url = IMAGE_RE.test(a.mimeType || "") ? attachmentUrl(chatId, a) : "";
  const open = a.path ? ' data-open-file="' + esc(a.path) + '"' : "";
  if (url) return '<button type="button" class="att-thumb"' + open + ' title="' + name + '"><img src="' + esc(url) + '" alt="' + name + '" loading="lazy"></button>';
  return '<button type="button" class="att-file"' + open + ' title="' + esc(a.path || a.name) + '">' + icon("file", 15) + '<span class="att-name">' + name + '</span><span class="att-size">' + fileSize(a.size || 0) + "</span></button>";
}

// A row's key: its id, or its place for rows saved before rows had ids.
function rowKey(row, index) {
  return row.id || "i" + index;
}

// Puts the blocks in the transcript, reusing every element whose markup did
// not change and moving none that are already in place.
function reconcile(inner, blocks) {
  const existing = new Map();
  for (const el of Array.from(inner.children)) {
    const k = el.dataset ? el.dataset.key : "";
    if (k && !existing.has(k)) existing.set(k, el);
    else el.remove();
  }
  let prev = null;
  for (const b of blocks) {
    let el = existing.get(b.key);
    existing.delete(b.key);
    if (!el || el._html !== b.html) {
      const tpl = document.createElement("template");
      tpl.innerHTML = b.html;
      const fresh = tpl.content.firstElementChild || document.createElement("div");
      fresh.dataset.key = b.key;
      fresh._html = b.html;
      if (el) el.replaceWith(fresh);
      el = fresh;
    }
    const want = prev ? prev.nextSibling : inner.firstChild;
    if (want !== el) inner.insertBefore(el, want);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

const SUB_STATUS = { busy: "Working", starting: "Starting", ready: "Done", idle: "Idle", error: "Error", stopped: "Stopped" };

function subagentCard(c) {
  const st = c.status || "idle";
  const open = c.chatId ? 'data-open-chat="' + esc(c.chatId) + '"' : 'data-open-sub="' + esc(c.handle) + '"';
  return (
    '<button type="button" class="sub-card" ' + open + ' title="Open ' + esc(c.handle || "subagent") + '">' +
    harnessIcon(c.harnessId, 15) + '<span class="sub-handle">' + esc(c.handle || "subagent") + '</span><span class="sub-title muted">' + esc(c.title || "") + "</span>" +
    '<span class="sub-status is-' + esc(st) + '">' + (st === "busy" || st === "starting" ? '<span class="spinner sm"></span>' : "") + esc(SUB_STATUS[st] || st) + "</span></button>"
  );
}

export function statusLabel(snap) {
  if (!snap) return { text: "", tone: "" };
  if (snap.status === "starting") return { text: "Starting", tone: "busy" };
  if (snap.status === "busy") return { text: snap.queued ? "Working · " + snap.queued + " queued" : "Working", tone: "busy" };
  if (snap.status === "error") return { text: "Stopped", tone: "error" };
  if (snap.status === "ready") return { text: "Ready", tone: "ok" };
  return { text: "Idle", tone: "" };
}

export class ChatView {
  constructor(el, opts) {
    this.el = el;
    this.opts = opts || {};
    this.chatId = this.opts.chatId || "";
    this.newAgent = this.opts.agentId || (store.acpAgents.find((a) => a.available) || { id: "devin" }).id;
    this.snap = null;
    this.forceScroll = true;
    // Open or closed by the user, by row key; rows not in here use their default.
    this.toolOpen = new Map();
    this.openThoughts = new Set();
    // Rendered rows by key: {sig, html}. Only rows whose sig changed are redrawn.
    this.rowCache = new Map();
    this.seenKeys = new Set();
    this.markerKey = "";
    this.unseen = 0;
    // Permission mode picked in a new thread before its chat exists.
    this.pendingPerm = "";
    // Up-arrow recall of sent messages: index into them, and the draft it replaced.
    this.recall = -1;
    this.recallSaved = "";
    // Slash command and @file menu: {type, start, items, index}.
    this.ac = null;
    this.acSeq = 0;
    this.draftTimer = 0;
    this.findQuery = "";
    this.findIndex = 0;
    this.findTimer = 0;
    // A plugin subagent open as a thread over this chat: its handle and rows.
    this.subOpen = "";
    this.subData = null;
    // Files waiting in the composer: {key, name, mimeType, size, path | data, preview}.
    this.pending = [];
    // Effort picked in a new thread before its chat exists.
    this.pendingEffort = "";
    // The agent whose models the open picker shows (not chosen until a model is).
    this.viewHarness = "";
    // Thread mode reuses one element for every thread it opens, so every
    // listener goes through this signal and destroy() drops them. Stale
    // listeners used to stack up and toggle the Agent and Model menus open
    // and shut again on one click.
    this.abort = new AbortController();
    this.destroyed = false;
    this.el.classList.add("chatview");
    if (this.opts.compact) this.el.classList.add("compact");
    this.el.innerHTML =
      '<div class="find-bar" data-find hidden role="search">' + icon("search", 14) +
      '<input type="text" data-find-input placeholder="Find in chat" aria-label="Find in chat" autocomplete="off" spellcheck="false">' +
      '<span class="find-count muted small" data-find-count></span>' +
      '<button type="button" class="icon-btn" data-find-prev aria-label="Previous match" title="Previous match (Shift+Enter)">' + icon("chevronUp", 14) + "</button>" +
      '<button type="button" class="icon-btn" data-find-next aria-label="Next match" title="Next match (Enter)">' + icon("chevronDown", 14) + "</button>" +
      '<button type="button" class="icon-btn" data-find-close aria-label="Close find" title="Close (Esc)">' + icon("close", 14) + "</button></div>" +
      '<div class="transcript"><div class="transcript-inner"></div></div>' +
      '<div class="composer-wrap"><button type="button" class="jump-latest" data-jump hidden>' + icon("arrowDown", 14) + '<span data-jump-label>Jump to latest</span></button><div class="composer-inner">' +
      '<div class="queue-list" data-queue hidden></div>' +
      '<form class="composer-card" data-form>' +
      '<div class="ac-menu news-menu" data-ac hidden role="listbox" aria-label="Suggestions"></div>' +
      '<div class="attach-tray" data-tray hidden></div>' +
      '<div class="composer-input-wrap"><textarea data-input rows="1" placeholder="' + esc(this.opts.placeholder || "Message the agent") + '"></textarea></div>' +
      '<p class="muted small composer-hint" data-hint></p>' +
      '<div class="composer-foot"><div class="composer-settings">' +
      '<button type="button" class="news-pill attach-btn" data-attach aria-label="Attach files" title="Attach files. You can also paste or drop them here.">' + icon("paperclip", 16) + "</button>" +
      '<div class="harness-picker" data-picker></div><div class="harness-picker effort-picker" data-effort hidden></div><div class="harness-picker perm-picker" data-perm></div></div>' +
      '<p class="composer-keys" aria-hidden="true"><kbd>Enter</kbd> send <span>·</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</p><div class="composer-submit">' +
      '<span class="ctx-ring" data-ctx hidden></span>' +
      '<button type="button" class="send-btn stop" data-stop hidden>' + icon("stop", 12) + "<span>Stop</span></button>" +
      '<button type="button" class="send-btn" data-send aria-label="Send">' + icon("arrowUp", 16) + "</button>" +
      "</div></div></form></div></div>" +
      '<div class="drop-overlay" data-drop hidden>' + icon("paperclip", 22) + "<span>Drop files to attach</span></div>" +
      '<div class="sub-view" data-sub-view hidden></div>';
    this.input = this.el.querySelector("[data-input]");
    this.wire();
    views.add(this);
    this.load();
  }

  async load() {
    if (this.chatId) {
      try {
        this.snap = await window.jagents.chats.get(this.chatId);
      } catch (error) {
        toast(errorText(error));
      }
    }
    if (this.destroyed) return;
    this.paint();
    this.loadDraft();
    const id = this.currentAgentId();
    const cached = store.modelCache[id];
    if (!(cached && cached.models && cached.models.availableModels && cached.models.availableModels.length) && !(cached && cached.probing)) refreshModelInfo(id);
  }

  destroy() {
    this.saveDraft(true);
    this.closeFind();
    this.destroyed = true;
    views.delete(this);
    this.abort.abort();
    this.el.classList.remove("chatview", "compact");
    this.el.innerHTML = "";
  }

  focus() {
    this.input.focus();
  }

  setSnap(snap) {
    if (this.destroyed) return;
    this.snap = snap;
    this.paint();
  }

  onModels() {
    this.paintToggles();
    this.repaintMenu();
  }

  // Redraws the open picker in place, keeping the search text and focus.
  repaintMenu() {
    const popup = this.el.querySelector("[data-picker-popup]");
    if (!popup || !popup.querySelector("[data-picker-menu]")) return;
    const old = popup.querySelector("[data-menu-search]");
    const query = old ? old.value : "";
    const hadFocus = old && document.activeElement === old;
    const focusedTab = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.harnessTab : "";
    popup.innerHTML = this.pickerMenuMarkup();
    const inp = popup.querySelector("[data-menu-search]");
    if (inp && query) {
      inp.value = query;
      applyFilter(popup.querySelector("[data-model-list]"), query);
    }
    if (inp && hadFocus) inp.focus();
    else if (focusedTab) {
      const tab = popup.querySelector('[data-harness-tab="' + CSS.escape(focusedTab) + '"]');
      if (tab) tab.focus();
    }
  }

  currentAgentId() {
    return this.snap ? this.snap.harnessId : this.newAgent;
  }

  currentAgent() {
    const id = this.currentAgentId();
    return store.acpAgents.find((a) => a.id === id) || { id, name: id || "Agent", available: false };
  }

  modelInfo(harnessId) {
    const snap = this.snap;
    const id = harnessId || this.currentAgentId();
    if (id === this.currentAgentId() && snap && snap.models && snap.models.availableModels.length) return { list: snap.models.availableModels, selected: snap.models.currentModelId, live: true };
    const cached = store.modelCache[id] || {};
    const models = cached.models || {};
    if (models.availableModels && models.availableModels.length) return { list: models.availableModels, selected: cached.preferred || models.currentModelId, live: false };
    return { list: [], selected: "", live: false, probing: Boolean(cached.probing), error: cached.error || "" };
  }

  busy() {
    return Boolean(this.snap && (this.snap.status === "busy" || this.snap.status === "starting"));
  }

  rowMarkup(row, index) {
    if (row.role === "user") {
      const from = row.from ? '<span class="from-tag">' + icon("hub", 12) + esc(row.from) + "</span>" : "";
      const files = Array.isArray(row.attachments) && row.attachments.length ? '<div class="msg-attachments">' + row.attachments.map((a) => attachmentMarkup(this.chatId, a)).join("") + "</div>" : "";
      const text = row.text ? '<div class="bubble">' + esc(row.text) + "</div>" : "";
      return '<div class="msg user' + (row.from ? " relayed" : "") + '">' + from + files + text + "</div>";
    }
    if (row.role === "agent") return '<div class="msg agent"><div class="bubble">' + markdown(row.text) + "</div></div>";
    if (row.role === "thought") {
      const key = rowKey(row, index);
      return '<details class="thought" data-thought="' + esc(key) + '"' + (this.openThoughts.has(key) ? " open" : "") + "><summary>Thinking</summary><div>" + esc(row.text) + "</div></details>";
    }
    if (row.role === "tool") {
      const st = row.status || "pending";
      const key = rowKey(row, index);
      const kind = String(row.kind || "").toLowerCase();
      const body = toolBody(row);
      const head = toolStatusIcon(st) + '<span class="tool-line">' + toolLabel(row) + "</span>";
      if (!body) return '<div class="tool ' + esc(st) + " kind-" + esc(kind || "other") + '">' + head + "</div>";
      // Diffs and failed commands show open until the user closes them.
      const byDefault = Boolean((row.diffs && row.diffs.length) || (row.exitCode != null && row.exitCode !== 0));
      const open = this.toolOpen.has(key) ? this.toolOpen.get(key) : byDefault;
      return '<details class="tool ' + esc(st) + " kind-" + esc(kind || "other") + '" data-tool="' + esc(key) + '"' + (open ? " open" : "") + "><summary>" + head + '</summary><div class="tool-body">' + body + "</div></details>";
    }
    if (row.role === "plan") {
      return '<div class="plan"><strong>Plan</strong>' + (row.entries || []).map((e) => '<div class="plan-row ' + (e.status === "completed" ? "done" : esc(e.status)) + '"><span class="plan-mark">' + (e.status === "completed" ? icon("check", 13) : e.status === "in_progress" ? icon("next", 13) : "") + "</span>" + esc(e.content) + "</div>").join("") + "</div>";
    }
    if (row.role === "error") {
      const retry = index === this.lastErrorIndex && !this.busy() ? '<button type="button" class="btn sm secondary" data-retry>' + icon("retry", 14) + "Retry</button>" : "";
      return '<div class="err-row"><span class="grow">' + esc(row.text) + "</span>" + retry + "</div>";
    }
    if (row.role === "system" && row.kind === "handoff") return '<div class="sys handoff">' + icon("handoff", 13) + "<span>" + esc(row.text) + "</span></div>";
    if (row.role === "system" && row.kind === "handoff-in") {
      return '<div class="sys handoff">' + icon("handoff", 13) + "<span>" + esc(row.text) + "</span>" + (row.file ? '<button type="button" class="link" data-open-file="' + esc(row.file) + '">View</button>' : "") + "</div>";
    }
    return '<div class="sys">' + esc(row.text) + "</div>";
  }

  // A start that needs sign-in shows the agent's own sign-in methods.
  errorMarkup() {
    const snap = this.snap;
    const methods = snap.authMethods || [];
    if (!methods.length) return '<div class="err-row">' + esc(snap.error) + "</div>";
    if (this.signingIn) return '<div class="auth-card"><div class="auth-head">' + icon("lock", 15) + "<b>Signing in to " + esc(snap.agentName) + '…</b></div><p class="muted small">If a browser window opened, finish signing in there. Your message is sent once you are in.</p></div>';
    return (
      '<div class="auth-card"><div class="auth-head">' + icon("lock", 15) + "<b>" + esc(snap.error) + "</b></div>" +
      methods
        .map((m) =>
          '<div class="auth-method"><div class="grow"><b>' + esc(m.name) + "</b>" + (m.description ? '<span class="muted small">' + esc(m.description) + "</span>" : "") + "</div>" +
          (m.needsKey ? '<input type="password" data-auth-key="' + esc(m.id) + '" placeholder="' + esc(m.keyLabel) + '" aria-label="' + esc(m.keyLabel) + '" autocomplete="off">' : "") +
          (m.terminal ? "" : '<button type="button" class="btn sm primary" data-auth="' + esc(m.id) + '">Sign in</button>') + "</div>",
        )
        .join("") +
      "</div>"
    );
  }

  async signIn(methodId) {
    const field = this.el.querySelector('[data-auth-key="' + CSS.escape(methodId) + '"]');
    const secret = field ? field.value : "";
    this.signingIn = true;
    this.paint();
    try {
      const snap = await window.jagents.chats.authenticate(this.chatId, methodId, secret);
      this.signingIn = false;
      if (snap) this.setSnap(snap);
    } catch (error) {
      this.signingIn = false;
      toast(errorText(error));
      if (this.chatId && views.has(this)) this.setSnap(await window.jagents.chats.get(this.chatId));
    }
  }

  introMarkup() {
    const agent = this.currentAgent();
    return (
      '<div class="intro">' + harnessIcon(agent.id, 28) +
      "<h1>" + esc(agent.name) + "</h1>" +
      '<p class="muted">' + esc(this.opts.introText || "Ask for a change, a review, or a plan. The agent works in " + ((this.snap && this.snap.cwd) || (store.info && store.info.cwd) || "the workspace folder") + ".") + "</p></div>"
    );
  }

  paint() {
    if (this.destroyed) return;
    const scroller = this.el.querySelector(".transcript");
    const pinned = nearBottom(scroller);
    const inner = scroller.querySelector(".transcript-inner");
    const rows = this.snap ? this.snap.transcript : [];
    // Rows that arrive while the reader is scrolled up get a "New messages" line.
    const follow = pinned || this.forceScroll;
    if (follow) {
      this.markerKey = "";
      this.unseen = 0;
    }
    let fresh = 0;
    rows.forEach((r, i) => {
      const k = rowKey(r, i);
      if (this.seenKeys.has(k)) return;
      this.seenKeys.add(k);
      if (!follow && this.painted && r.role !== "user") {
        fresh++;
        if (!this.markerKey) this.markerKey = k;
      }
    });
    this.unseen += fresh;
    this.painted = true;
    reconcile(inner, this.blocks(rows));
    if (this.subOpen) this.paintSub();
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    this.forceScroll = false;
    this.paintJump();
    this.paintToggles();
    this.paintQueue();
    const agent = this.currentAgent();
    const hint = this.el.querySelector("[data-hint]");
    hint.textContent = agent && !agent.available ? agent.name + " is not installed. " + (agent.install || "") : "";
    const busy = this.busy();
    // While the agent works, Send queues the message and Stop ends the turn.
    this.el.querySelector("[data-send]").setAttribute("aria-label", busy ? "Queue message" : "Send");
    this.el.querySelector("[data-send]").title = busy ? "Queue this message. It is sent when the agent finishes." : "Send";
    this.el.querySelector("[data-stop]").hidden = !busy;
    if (this.findOpen()) this.scheduleFind();
    if (this.opts.onChange) this.opts.onChange(this.snap);
  }

  // Everything the transcript shows, as keyed blocks of markup.
  blocks(rows) {
    const snap = this.snap;
    if (!rows.length && !(snap && snap.permissions && snap.permissions.length)) return [{ key: "intro", html: this.introMarkup() }];
    const busy = this.busy();
    this.lastErrorIndex = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === "user") break;
      if (rows[i].role === "error") {
        this.lastErrorIndex = i;
        break;
      }
    }
    const children = this.children();
    const placed = new Set();
    const out = [];
    let turnStart = 0;
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      const key = rowKey(row, i);
      if (row.role === "user") turnStart = i;
      // A run of the same kind of finished tool call folds into one row.
      let end = i + 1;
      if (groupable(row)) while (end < rows.length && groupable(rows[end]) && rows[end].kind === row.kind) end++;
      const span = rows.slice(i, end);
      if (this.markerKey && span.some((r, n) => rowKey(r, i + n) === this.markerKey)) out.push({ key: "marker", html: '<div class="new-marker" role="separator"><span>New messages</span></div>' });
      if (span.length >= 2) {
        const gkey = "g-" + key;
        const sig = span.map((r, n) => rowKey(r, i + n) + ":" + this.rowSig(r, i + n)).join(",") + (this.toolOpen.get(gkey) ? "|o" : "");
        out.push(this.cached(gkey, sig, () => {
          const open = this.toolOpen.get(gkey) ? " open" : "";
          return '<details class="tool-group" data-tool="' + esc(gkey) + '"' + open + "><summary>" + groupIcon(span) + '<span class="tool-verb">' + esc(groupLabel(span)) + "</span>" + icon("chevronDown", 12) + '</summary><div class="tool-group-rows">' + span.map((r, n) => this.rowMarkup(r, i + n)).join("") + "</div></details>";
        }));
      } else {
        out.push(this.cached(key, this.rowSig(row, i), () => this.rowMarkup(row, i)));
      }
      // Subagents this row started, with their live status.
      for (const r of span) {
        if (r.role !== "tool") continue;
        const text = [r.title, r.input, r.output].join(" ");
        for (const c of children) {
          if (placed.has(c.key) || !c.handle || !text.includes(c.handle)) continue;
          placed.add(c.key);
          out.push({ key: "sub-" + c.key, html: subagentCard(c) });
        }
      }
      // The files a finished turn changed.
      const last = end - 1;
      const turnEnds = end >= rows.length ? !busy : rows[end].role === "user";
      if (turnEnds) {
        const turn = rows.slice(turnStart, last + 1);
        const sig = turn.filter((r) => r.role === "tool" && r.diffs).map((r) => rowKey(r, 0) + r.status + r.diffs.length).join(",");
        if (sig) {
          const block = this.cached("roll-" + key, sig, () => turnRollup(turn));
          if (block.html) out.push(block);
        }
      }
      i = end;
    }
    for (const c of children) if (!placed.has(c.key)) out.push({ key: "sub-" + c.key, html: subagentCard(c) });
    for (const p of (snap && snap.permissions) || []) out.push({ key: "perm-" + p.id, html: this.permissionMarkup(p) });
    if (snap && (snap.status === "busy" || snap.status === "starting")) {
      const waiting = snap.permissions && snap.permissions.length;
      const text =
        snap.status === "starting"
          ? this.signingIn
            ? "Signing in to " + esc(snap.agentName || "the agent") + "… If a browser window opened, finish signing in there."
            : "Starting " + esc(snap.agentName || "agent") + "…"
          : waiting
            ? esc(snap.agentName || "The agent") + " is waiting for your approval."
            : esc(snap.agentName || "Agent") + " is working…";
      out.push({ key: "working", html: '<div class="working"><span class="spinner"></span>' + text + "</div>" });
    }
    // The session's error, unless the last row already says the same thing.
    const lastRow = rows[rows.length - 1];
    const repeated = lastRow && lastRow.role === "error" && lastRow.text === (snap && snap.error) && !(snap.authMethods || []).length;
    if (snap && snap.status === "error" && snap.error && !repeated) out.push({ key: "err-state", html: this.errorMarkup() });
    return out;
  }

  // ---- A subagent's thread, shown over this chat ----

  openSub(handle) {
    this.subOpen = handle;
    this.subData = null;
    this.subPainted = false;
    this.paintSub();
    this.loadSub();
    const back = this.el.querySelector("[data-sub-back]");
    if (back) back.focus();
  }

  closeSub() {
    if (!this.subOpen) return;
    this.subOpen = "";
    this.subData = null;
    const box = this.el.querySelector("[data-sub-view]");
    box.hidden = true;
    box.innerHTML = "";
    box._html = "";
    this.paint();
    this.input.focus();
  }

  async loadSub() {
    const handle = this.subOpen;
    if (!handle) return;
    let data = null;
    try {
      data = await window.jagents.plugins.invoke("subagents", "transcript", { handle });
    } catch (error) {
      data = { handle, error: errorText(error) };
    }
    if (this.subOpen !== handle || this.destroyed) return;
    this.subData = data;
    this.paintSub();
  }

  paintSub() {
    const box = this.el.querySelector("[data-sub-view]");
    const handle = this.subOpen;
    const s = this.subData || pluginSubs.find((x) => x.handle === handle) || { handle };
    const st = s.status || "idle";
    if (box.hidden) {
      box.hidden = false;
      box.innerHTML =
        '<header class="sub-view-head"><button type="button" class="btn sm ghost" data-sub-back title="Back to the parent thread (Esc)">' + icon("back", 15) + "<span>Back</span></button>" +
        '<span data-sub-head class="sub-view-title"></span></header>' +
        '<div class="transcript" data-sub-scroll><div class="transcript-inner"></div></div>' +
        '<footer class="sub-view-foot muted small" data-sub-foot></footer>';
    }
    const head = box.querySelector("[data-sub-head]");
    const headHtml =
      harnessIcon(s.provider, 15) + '<span class="sub-handle">' + esc(handle) + "</span>" +
      (s.providerName ? '<span class="muted small">' + esc(s.providerName) + " subagent</span>" : "") +
      '<span class="sub-status is-' + esc(st) + '">' + (st === "busy" || st === "starting" ? '<span class="spinner sm"></span>' : "") + esc(SUB_STATUS[st] || st) + "</span>";
    if (head._html !== headHtml) head.innerHTML = head._html = headHtml;
    const parent = s.parent || handle.split("/").slice(0, -1).join("/");
    const foot = box.querySelector("[data-sub-foot]");
    const footText = "Only " + parent + " can message or stop this subagent. Go back and ask " + parent + " if you want something from it.";
    if (foot.textContent !== footText) foot.textContent = footText;

    const scroller = box.querySelector("[data-sub-scroll]");
    const pinned = nearBottom(scroller);
    const out = [];
    if (s.task) out.push({ key: "task", html: '<div class="msg user relayed"><span class="from-tag">' + icon("hub", 12) + esc(parent) + '</span><div class="bubble">' + esc(s.task) + "</div></div>" });
    const rows = s.rows || null;
    if (!rows) out.push({ key: "loading", html: '<div class="sys">' + (s.error && !s.status ? esc(s.error) : "Loading…") + "</div>" });
    else {
      rows.forEach((r, i) => {
        // The plugin keeps short rows; draw them as this chat's own rows.
        if (i === 0 && r.role === "user" && r.text === s.task) return;
        const row =
          r.role === "assistant" ? { role: "agent", text: r.text }
          : r.role === "tool" ? { role: "tool", id: r.id, title: r.text, status: r.status }
          : r.role === "user" ? { role: "user", text: r.text, from: parent }
          : r;
        const id = "sub:" + handle + ":" + i;
        const sig = [row.role, row.status, row.title, (row.text || "").length, this.openThoughts.has(id) ? "o" : ""].join("|");
        out.push(this.cached(id, sig, () => this.rowMarkup(Object.assign({}, row, { id }), i)));
      });
    }
    // Its permission requests can be answered here too; others wait in the parent.
    let elsewhere = 0;
    for (const p of (this.snap && this.snap.permissions) || []) {
      if (p.from && p.from.handle === handle) out.push({ key: "perm-" + p.id, html: this.permissionMarkup(p) });
      else elsewhere++;
    }
    if (elsewhere) out.push({ key: "perm-elsewhere", html: '<div class="sys handoff">' + icon("shield", 13) + "<span>" + esc(parent) + " is waiting for your approval.</span>" + '<button type="button" class="link" data-sub-back>Back to approve</button></div>' });
    if (st === "busy" || st === "starting") out.push({ key: "working", html: '<div class="working"><span class="spinner"></span>' + esc(handle) + " is working…</div>" });
    if (st === "error" && s.error) out.push({ key: "err", html: '<div class="err-row">' + esc(s.error) + "</div>" });
    reconcile(scroller.querySelector(".transcript-inner"), out);
    if (pinned || !this.subPainted) scroller.scrollTop = scroller.scrollHeight;
    this.subPainted = true;
  }

  cached(key, sig, build) {
    const hit = this.rowCache.get(key);
    if (hit && hit.sig === sig) return { key, html: hit.html };
    const html = build();
    this.rowCache.set(key, { sig, html });
    return { key, html };
  }

  // What a row's markup depends on; rows only grow or change status.
  rowSig(row, index) {
    const key = rowKey(row, index);
    const len = (v) => (v ? String(v).length : 0);
    return [
      row.role, row.status, row.title, row.kind, len(row.text), len(row.output), len(row.input), len(row.terminalOutput), row.exitCode,
      (row.diffs || []).length, (row.paths || []).length, row.role === "plan" ? JSON.stringify(row.entries) : "",
      this.toolOpen.has(key) ? String(this.toolOpen.get(key)) : "", this.openThoughts.has(key) ? "o" : "",
      row.role === "error" ? String(index === this.lastErrorIndex && !this.busy()) : "",
    ].join("|");
  }

  // Subagents this chat started: the subagents plugin's (by this chat's
  // handle) and chats spawned through the hub (by parent id).
  children() {
    if (!this.chatId) return [];
    const mine = this.snap && this.snap.handle;
    const plugin = mine
      ? pluginSubs.filter((s) => s.parent === mine).map((s) => ({ chatId: "", key: s.handle, status: s.status, title: s.task, handle: s.handle, harnessId: s.provider }))
      : [];
    const chats = (store.chats || [])
      .filter((c) => c.parentId === this.chatId)
      .map((c) => Object.assign({ chatId: c.id, key: c.id, status: "idle", title: c.title, handle: c.handle, harnessId: c.harnessId }, chatStates.get(c.id) || {}));
    return plugin.concat(chats);
  }

  // ---- Permission cards ----------------------------------------------------

  permissionMarkup(p) {
    // A subagent's request names the subagent, so it is clear who asks.
    const who = p.from
      ? harnessIcon(p.from.harnessId, 14) + "<span>" + esc(p.from.handle) + '</span> <span class="perm-from muted">(' + esc(p.from.agentName) + " subagent)</span>"
      : esc((this.snap && this.snap.agentName) || "The agent");
    let detail = "";
    if (p.diffs && p.diffs.length) detail = p.diffs.slice(0, 3).map(diffCard).join("");
    else if (p.input) {
      let shown = p.input;
      try {
        const parsed = JSON.parse(p.input);
        shown = typeof parsed.command === "string" ? "$ " + parsed.command : JSON.stringify(parsed, null, 2);
      } catch {
        /* as sent */
      }
      detail = '<pre class="perm-input">' + esc(shown) + "</pre>";
    }
    const buttons = p.options
      .map((o) => {
        const reject = /reject|deny/.test(o.kind + " " + o.optionId);
        const cls = reject ? "secondary" : /always/.test(o.kind) ? "secondary" : "primary";
        return '<button type="button" class="btn sm ' + cls + (reject ? " perm-reject" : "") + '" data-perm-answer="' + esc(p.id) + '" data-perm-option="' + esc(o.optionId) + '">' + esc(o.name) + "</button>";
      })
      .join("");
    return (
      '<div class="perm-card" role="group" aria-label="Approval needed">' +
      '<div class="perm-head">' + icon("shield", 15) + "<b>" + who + " wants to: " + esc(p.title) + "</b></div>" +
      (p.description ? '<p class="muted small">' + esc(p.description) + "</p>" : "") +
      detail +
      '<div class="perm-actions">' + buttons + '<span class="grow"></span><button type="button" class="link small" data-open-perm-mode>Change what needs approval</button></div></div>'
    );
  }

  async answerPermission(id, optionId) {
    try {
      this.setSnap(await window.jagents.chats.answerPermission(this.chatId, id, optionId));
    } catch (error) {
      toast(errorText(error));
    }
  }

  // ---- Queue cards ---------------------------------------------------------

  paintQueue() {
    const slot = this.el.querySelector("[data-queue]");
    const q = (this.snap && this.snap.queue) || [];
    if (slot.querySelector("[data-queue-input]")) {
      // Keep an open editor; drop it only if its message went out.
      const id = slot.querySelector("[data-queue-input]").dataset.queueInput;
      if (q.some((x) => x.id === id)) return;
    }
    const html = q
      .map(
        (m) =>
          '<div class="queue-item" data-qid="' + esc(m.id) + '">' +
          '<span class="queue-tag">' + (m.from ? icon("hub", 12) + esc(m.from) : "Queued") + "</span>" +
          '<span class="queue-text" title="' + esc(m.text) + '">' + esc(m.text || (m.files ? m.files + " file" + (m.files === 1 ? "" : "s") : "")) + "</span>" +
          (m.from ? "" : '<button type="button" class="icon-btn" data-queue-edit="' + esc(m.id) + '" aria-label="Edit queued message" title="Edit">' + icon("pencil", 13) + "</button>") +
          '<button type="button" class="icon-btn" data-queue-remove="' + esc(m.id) + '" aria-label="Remove queued message" title="Remove">' + icon("close", 13) + "</button></div>",
      )
      .join("");
    if (slot._html === html) return;
    slot._html = html;
    slot.innerHTML = html;
    slot.hidden = !q.length;
  }

  editQueued(id) {
    const m = ((this.snap && this.snap.queue) || []).find((x) => x.id === id);
    const item = this.el.querySelector('[data-qid="' + CSS.escape(id) + '"]');
    if (!m || !item) return;
    item.innerHTML =
      '<textarea class="queue-edit" data-queue-input="' + esc(id) + '" rows="2" aria-label="Edit queued message"></textarea>' +
      '<button type="button" class="btn sm primary" data-queue-save="' + esc(id) + '">Save</button>' +
      '<button type="button" class="btn sm ghost" data-queue-cancel>Cancel</button>';
    const ta = item.querySelector("textarea");
    ta.value = m.text;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  async saveQueued(id) {
    const ta = this.el.querySelector('[data-queue-input="' + CSS.escape(id) + '"]');
    const text = ta ? ta.value : "";
    this.el.querySelector("[data-queue]")._html = "";
    if (ta) ta.removeAttribute("data-queue-input");
    try {
      this.setSnap(await window.jagents.chats.editQueued(this.chatId, id, text));
    } catch (error) {
      toast(errorText(error));
      this.paintQueue();
    }
    this.input.focus();
  }

  async removeQueued(id) {
    try {
      this.setSnap(await window.jagents.chats.removeQueued(this.chatId, id));
    } catch (error) {
      toast(errorText(error));
    }
  }

  // Stop: the turn ends and the user's queued messages come back to the composer.
  async stop() {
    if (!this.chatId) return;
    const mine = ((this.snap && this.snap.queue) || []).filter((m) => !m.from && m.text).map((m) => m.text);
    if (mine.length) {
      const cur = this.input.value.trim();
      this.input.value = mine.concat(cur ? [cur] : []).join("\n\n");
      autoGrow(this.input);
      this.saveDraft();
    }
    try {
      await window.jagents.chats.cancel(this.chatId);
    } catch (error) {
      toast(errorText(error));
    }
  }

  async retry() {
    try {
      this.forceScroll = true;
      const done = await window.jagents.chats.retry(this.chatId);
      if (done && views.has(this)) this.setSnap(done);
    } catch (error) {
      toast(errorText(error));
    }
  }

  // ---- Jump to latest ------------------------------------------------------

  paintJump() {
    const scroller = this.el.querySelector(".transcript");
    const btn = this.el.querySelector("[data-jump]");
    const away = !nearBottom(scroller) && scroller.scrollHeight > scroller.clientHeight;
    if (btn.hidden === away) btn.hidden = !away;
    const label = this.unseen ? this.unseen + " new message" + (this.unseen === 1 ? "" : "s") : "Jump to latest";
    const span = btn.querySelector("[data-jump-label]");
    if (span.textContent !== label) span.textContent = label;
  }

  jumpToLatest() {
    const scroller = this.el.querySelector(".transcript");
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }

  onScroll() {
    const scroller = this.el.querySelector(".transcript");
    if (nearBottom(scroller) && (this.unseen || this.markerKey)) {
      this.unseen = 0;
      // The marker stays until the next message so the reader sees where they were.
    }
    this.paintJump();
  }

  // ---- Find in chat --------------------------------------------------------

  findOpen() {
    return !this.el.querySelector("[data-find]").hidden;
  }

  openFind() {
    for (const v of views) if (v !== this) v.closeFind();
    const bar = this.el.querySelector("[data-find]");
    bar.hidden = false;
    const input = bar.querySelector("[data-find-input]");
    const sel = String(window.getSelection() || "").trim();
    if (sel && sel.length < 200 && !sel.includes("\n")) input.value = sel;
    input.focus();
    input.select();
    this.runFind(true);
  }

  closeFind() {
    const bar = this.el.querySelector("[data-find]");
    if (!bar || bar.hidden) return;
    bar.hidden = true;
    if (typeof CSS !== "undefined" && CSS.highlights) {
      CSS.highlights.delete("jagents-find");
      CSS.highlights.delete("jagents-find-current");
    }
    if (!this.destroyed) this.input.focus();
  }

  scheduleFind() {
    clearTimeout(this.findTimer);
    this.findTimer = setTimeout(() => this.runFind(false), 150);
  }

  // Highlights every match with the CSS Highlight API (no DOM changes, so the
  // row patching is unaffected). Text inside closed rows is skipped.
  runFind(reset, step) {
    const bar = this.el.querySelector("[data-find]");
    const query = bar.querySelector("[data-find-input]").value;
    const count = bar.querySelector("[data-find-count]");
    if (reset || query !== this.findQuery) this.findIndex = 0;
    this.findQuery = query;
    const ranges = [];
    const needle = query.toLowerCase();
    if (needle) {
      const inner = this.el.querySelector(".transcript-inner");
      const walker = document.createTreeWalker(inner, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
          const parent = node.parentElement;
          if (!parent || parent.closest(".jui-copy, .jui-code-head, button.icon-btn")) return NodeFilter.FILTER_REJECT;
          const d = parent.closest("details");
          if (d && !d.open && !parent.closest("summary")) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let node = walker.nextNode(); node && ranges.length < 2000; node = walker.nextNode()) {
        const text = node.data.toLowerCase();
        let at = text.indexOf(needle);
        while (at >= 0) {
          const r = new Range();
          r.setStart(node, at);
          r.setEnd(node, at + needle.length);
          ranges.push(r);
          at = text.indexOf(needle, at + needle.length);
        }
      }
    }
    if (step) this.findIndex = ranges.length ? (this.findIndex + step + ranges.length) % ranges.length : 0;
    if (this.findIndex >= ranges.length) this.findIndex = Math.max(0, ranges.length - 1);
    count.textContent = needle ? (ranges.length ? this.findIndex + 1 + " of " + ranges.length : "No matches") : "";
    if (typeof CSS === "undefined" || !CSS.highlights) return;
    CSS.highlights.set("jagents-find", new Highlight(...ranges));
    const cur = ranges[this.findIndex];
    if (cur) {
      CSS.highlights.set("jagents-find-current", new Highlight(cur));
      if (reset || step) {
        const scroller = this.el.querySelector(".transcript");
        const box = cur.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        if (box.top < view.top + 20 || box.bottom > view.bottom - 20) scroller.scrollTop += box.top - view.top - view.height / 2;
      }
    } else CSS.highlights.delete("jagents-find-current");
  }

  // ---- Drafts and recall ---------------------------------------------------

  draftId() {
    return this.chatId || "new";
  }

  async loadDraft() {
    try {
      const text = await window.jagents.chats.getDraft(this.draftId());
      if (text && !this.input.value && !this.destroyed) {
        this.input.value = text;
        autoGrow(this.input);
      }
    } catch {
      /* no draft */
    }
  }

  saveDraft(now) {
    clearTimeout(this.draftTimer);
    const id = this.draftId();
    const text = this.input.value;
    const save = () => window.jagents.chats.setDraft(id, text).catch(() => {});
    if (now) save();
    else this.draftTimer = setTimeout(save, 400);
  }

  sentHistory() {
    const rows = (this.snap && this.snap.transcript) || [];
    const out = [];
    for (let i = rows.length - 1; i >= 0 && out.length < 50; i--) {
      const r = rows[i];
      if (r.role === "user" && !r.from && r.text && !out.includes(r.text)) out.push(r.text);
    }
    return out;
  }

  // Up arrow at the start of the composer steps back through sent messages;
  // down arrow at the end steps forward and back to the draft.
  recallStep(dir) {
    const list = this.sentHistory();
    if (!list.length) return false;
    if (this.recall < 0) {
      if (dir > 0) return false;
      this.recallSaved = this.input.value;
    }
    const next = this.recall + (dir < 0 ? 1 : -1);
    if (next >= list.length) return true;
    this.recall = next;
    this.input.value = next < 0 ? this.recallSaved : list[next];
    autoGrow(this.input);
    const end = this.input.value.length;
    this.input.setSelectionRange(dir < 0 ? 0 : end, dir < 0 ? 0 : end);
    return true;
  }

  // ---- Slash commands and @files -------------------------------------------

  async updateAc() {
    const v = this.input.value;
    const pos = this.input.selectionStart;
    const before = v.slice(0, pos);
    const slash = /^\/([^\s]*)$/.exec(before);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (slash) {
      const q = slash[1].toLowerCase();
      const list = ((this.snap && this.snap.commands) || []).filter((c) => c.name.toLowerCase().includes(q));
      list.sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
      const items = list.slice(0, 40).map((c) => ({ label: "/" + c.name, desc: c.description + (c.hint ? " " + c.hint : ""), insert: "/" + c.name + " " }));
      return this.showAc({ type: "slash", start: 0, end: pos, items });
    }
    if (at) {
      const seq = ++this.acSeq;
      const q = at[2];
      let files = [];
      try {
        files = await window.jagents.chats.files(this.chatId || "", q);
      } catch {
        files = [];
      }
      if (seq !== this.acSeq || this.input.selectionStart !== pos) return;
      const items = files.map((f) => ({ label: f, desc: "", insert: "@" + f + " ", file: true }));
      return this.showAc({ type: "file", start: pos - q.length - 1, end: pos, items });
    }
    this.closeAc();
  }

  showAc(state) {
    const menu = this.el.querySelector("[data-ac]");
    if (!state.items.length) return this.closeAc();
    const keep = this.ac && this.ac.type === state.type ? Math.min(this.ac.index, state.items.length - 1) : 0;
    this.ac = Object.assign(state, { index: keep });
    menu.innerHTML =
      '<p class="news-menu-label">' + (state.type === "slash" ? "Commands" : "Files") + "</p>" +
      state.items
        .map(
          (it, i) =>
            '<button type="button" role="option" class="news-menu-row' + (i === keep ? " is-selected" : "") + '" data-ac-pick="' + i + '" aria-selected="' + (i === keep) + '">' +
            (it.file ? icon("file", 14) : "") +
            '<span class="news-menu-text"><span class="news-menu-name">' + esc(it.label) + "</span>" + (it.desc ? '<span class="news-menu-desc">' + esc(it.desc) + "</span>" : "") + "</span></button>",
        )
        .join("");
    menu.hidden = false;
  }

  moveAc(step) {
    if (!this.ac) return;
    this.ac.index = (this.ac.index + step + this.ac.items.length) % this.ac.items.length;
    const menu = this.el.querySelector("[data-ac]");
    menu.querySelectorAll("[data-ac-pick]").forEach((b, i) => {
      b.classList.toggle("is-selected", i === this.ac.index);
      b.setAttribute("aria-selected", String(i === this.ac.index));
      if (i === this.ac.index) b.scrollIntoView({ block: "nearest" });
    });
  }

  pickAc(i) {
    const ac = this.ac;
    if (!ac) return;
    const it = ac.items[i == null ? ac.index : i];
    if (!it) return;
    const v = this.input.value;
    this.input.value = v.slice(0, ac.start) + it.insert + v.slice(ac.end);
    const caret = ac.start + it.insert.length;
    this.input.setSelectionRange(caret, caret);
    this.closeAc();
    autoGrow(this.input);
    this.input.focus();
    this.saveDraft();
  }

  closeAc() {
    this.ac = null;
    this.acSeq++;
    const menu = this.el.querySelector("[data-ac]");
    if (menu && !menu.hidden) {
      menu.hidden = true;
      menu.innerHTML = "";
    }
  }

  // ---- Permission mode picker and context ring -----------------------------

  permMode() {
    return (this.snap && this.snap.permissionMode) || this.pendingPerm || "ask";
  }

  paintPerm() {
    const slot = this.el.querySelector("[data-perm]");
    if (!slot) return;
    const mode = PERM_MODES.find((m) => m.value === this.permMode()) || PERM_MODES[0];
    const html =
      '<button type="button" class="news-pill harness-toggle perm-toggle mode-' + mode.value + '" data-perm-toggle aria-label="Permissions: ' + esc(mode.name) + '" aria-haspopup="listbox" aria-expanded="false" title="' + esc("Permissions for this thread: " + mode.name + ". " + mode.desc) + '">' +
      icon("shield", 15) + '<span class="news-pill-label">' + esc(mode.name) + "</span>" + icon("chevronDown", 12) + "</button>";
    if (slot._html === html) return;
    slot._html = html;
    const toggle = slot.querySelector("[data-perm-toggle]");
    if (!toggle) {
      slot.innerHTML = html + "<div data-perm-popup></div>";
      return;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const next = tpl.content.firstElementChild;
    for (const a of Array.from(toggle.attributes)) if (!next.hasAttribute(a.name)) toggle.removeAttribute(a.name);
    for (const a of Array.from(next.attributes)) if (a.name !== "aria-expanded") toggle.setAttribute(a.name, a.value);
    toggle.innerHTML = next.innerHTML;
  }

  openPerm() {
    if (this.el.querySelector("[data-perm-menu]")) return this.closePerm();
    this.closeMenus();
    this.closeEffort();
    const cur = this.permMode();
    const popup = this.el.querySelector("[data-perm-popup]");
    popup.innerHTML =
      '<div class="news-menu effort-menu perm-menu" data-perm-menu role="dialog" aria-label="Permissions">' +
      '<p class="news-menu-label">Permissions for this thread</p><div data-model-list role="listbox" aria-label="Permission modes">' +
      PERM_MODES.map((m) => {
        const picked = m.value === cur;
        return (
          '<button type="button" role="option" class="news-menu-row' + (picked ? " is-selected" : "") + '" data-perm-pick="' + m.value + '" aria-selected="' + picked + '">' +
          '<span class="news-menu-text"><span class="news-menu-name">' + esc(m.name) + '</span><span class="news-menu-desc">' + esc(m.desc) + "</span></span>" + (picked ? CHECK : "") + "</button>"
        );
      }).join("") +
      "</div></div>";
    this.el.querySelector("[data-perm-toggle]").setAttribute("aria-expanded", "true");
    const sel = popup.querySelector('[aria-selected="true"]');
    if (sel) sel.focus();
  }

  closePerm() {
    const menu = this.el.querySelector("[data-perm-menu]");
    if (menu) menu.remove();
    const toggle = this.el.querySelector("[data-perm-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  async choosePerm(mode) {
    this.closePerm();
    if (!this.chatId) {
      this.pendingPerm = mode;
      this.paintPerm();
    } else {
      try {
        this.setSnap(await window.jagents.chats.setPermissionMode(this.chatId, mode));
      } catch (error) {
        toast(errorText(error));
      }
    }
    const t = this.el.querySelector("[data-perm-toggle]");
    if (t) t.focus();
  }

  paintCtx() {
    const slot = this.el.querySelector("[data-ctx]");
    const u = this.snap && this.snap.usage;
    const show = Boolean(u && u.size > 0);
    if (slot.hidden === show) slot.hidden = !show;
    if (!show) return;
    const pct = Math.max(0, Math.min(100, (u.used / u.size) * 100));
    const r = 7;
    const c = 2 * Math.PI * r;
    const k = (n) => (n >= 1000 ? Math.round(n / 1000) + "k" : String(n));
    const tone = pct >= 90 ? " is-high" : pct >= 70 ? " is-mid" : "";
    const html =
      '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><circle cx="9" cy="9" r="' + r + '" class="ctx-track"/><circle cx="9" cy="9" r="' + r + '" class="ctx-fill' + tone + '" stroke-dasharray="' + c.toFixed(2) + '" stroke-dashoffset="' + (c * (1 - pct / 100)).toFixed(2) + '" transform="rotate(-90 9 9)"/></svg><span class="ctx-pct">' + Math.round(pct) + "%</span>";
    const title = "Context: " + k(u.used) + " of " + k(u.size) + " tokens (" + Math.round(pct) + "%)";
    if (slot._html !== html) {
      slot._html = html;
      slot.innerHTML = html;
    }
    slot.title = title;
    slot.setAttribute("role", "img");
    slot.setAttribute("aria-label", title);
  }

  // ---- Agent and model picker -------------------------------------------

  pickerToggleMarkup() {
    const snap = this.snap;
    const info = this.modelInfo();
    const model = info.list.find((m) => m.modelId === info.selected);
    const agent = this.currentAgent();
    const label = model ? model.name || model.modelId : (snap && snap.status === "starting") || info.probing ? "Loading…" : !agent.available ? "Not installed" : info.list.length ? info.selected || "Default" : agent.name;
    const title = this.busy() ? "Wait for this turn to finish, or press Stop, to change the agent or model." : agent.name + " · " + label;
    return (
      '<button type="button" class="news-pill harness-toggle" data-picker-toggle aria-label="Agent and model: ' + esc(agent.name + ", " + label) + '" aria-haspopup="dialog" aria-expanded="false" title="' + esc(title) + '"' + (this.busy() ? " disabled" : "") + ">" +
      harnessIcon(agent.id, 15) + '<span class="news-pill-label">' + esc(label) + "</span>" + icon("chevronDown", 12) + "</button>"
    );
  }

  // Installed agents first, in their usual order, then the ones to install.
  pickerAgents() {
    const list = store.acpAgents.slice();
    return list.filter((a) => a.available).concat(list.filter((a) => !a.available));
  }

  pickerMenuMarkup() {
    const current = this.currentAgentId();
    const viewId = this.viewHarness || current;
    const agents = this.pickerAgents();
    const view = agents.find((a) => a.id === viewId) || this.currentAgent();
    const bound = Boolean(this.snap && this.snap.transcript && this.snap.transcript.length);
    const tabs = agents
      .map((a) => {
        const active = a.id === view.id;
        const state = a.id === current ? " (in use)" : a.available ? "" : " (not installed)";
        return (
          '<button type="button" role="tab" class="harness-tab' + (active ? " is-active" : "") + (a.available ? "" : " is-missing") + '" data-harness-tab="' + esc(a.id) + '" aria-selected="' + active + '" tabindex="' + (active ? "0" : "-1") + '" title="' + esc(a.name + state) + '" aria-label="' + esc(a.name + state) + '">' +
          harnessIcon(a.id, 18) + "</button>"
        );
      })
      .join("");
    const more = '<button type="button" class="harness-tab harness-more" data-open-market title="Get more agents" aria-label="Get more agents">' + icon("plus", 16) + "</button>";
    const status = view.id === current ? "In use" : !view.available ? "Not installed" : bound ? "Picking a model hands this chat over" : "Pick a model to use it";
    const head = '<div class="harness-head"><span class="harness-head-name">' + esc(view.name) + '</span><span class="harness-head-state">' + esc(status) + "</span></div>";
    return (
      '<div class="news-menu harness-menu" data-picker-menu role="dialog" aria-label="Agent and model">' +
      '<div class="harness-tabs" role="tablist" aria-label="Agents">' + tabs + more + "</div>" + head +
      (bound && view.id !== current && view.available ? '<p class="menu-note">' + icon("handoff", 12) + "The new agent gets this chat's recent messages and tool calls.</p>" : "") +
      this.modelListMarkup(view) +
      "</div>"
    );
  }

  modelListMarkup(agent) {
    if (!agent.available) {
      return (
        '<div class="harness-empty"><p class="muted small">' + esc(agent.install || agent.name + " is not installed.") + "</p>" +
        '<button type="button" class="btn sm secondary" data-open-market>' + icon("store", 14) + "Get it from the marketplace</button></div>"
      );
    }
    const info = this.modelInfo(agent.id);
    const starting = agent.id === this.currentAgentId() && this.snap && this.snap.status === "starting";
    const selected = agent.id === this.currentAgentId() ? info.selected : "";
    if (!info.list.length) {
      if (starting || info.probing) return '<div data-model-list><p class="model-menu-empty"><span class="spinner sm"></span> Loading its models…</p></div>';
      const desc = info.error ? info.error : "This agent does not list models. It uses its own default.";
      return (
        '<div data-model-list role="listbox" aria-label="Models">' +
        '<button type="button" role="option" class="news-menu-row' + (agent.id === this.currentAgentId() ? " is-selected" : "") + '" data-model-pick="" data-model-agent="' + esc(agent.id) + '" aria-selected="' + (agent.id === this.currentAgentId()) + '">' +
        '<span class="news-menu-text"><span class="news-menu-name">Default model</span><span class="news-menu-desc">' + esc(desc) + "</span></span>" + (agent.id === this.currentAgentId() ? CHECK : "") + "</button></div>"
      );
    }
    const rows = info.list
      .map((m) => {
        const picked = m.modelId === selected;
        return (
          '<button type="button" class="news-menu-row' + (picked ? " is-selected" : "") + '" role="option" data-model-pick="' + esc(m.modelId) + '" data-model-agent="' + esc(agent.id) + '" data-menu-text="' + esc(((m.name || "") + " " + m.modelId + " " + (m.description || "")).toLowerCase()) + '" aria-selected="' + picked + '">' +
          '<span class="news-menu-text"><span class="news-menu-name">' + esc(m.name || m.modelId) + "</span>" + (m.description ? '<span class="news-menu-desc">' + esc(m.description) + "</span>" : "") + "</span>" + (picked ? CHECK : "") + "</button>"
        );
      })
      .join("");
    return searchMarkup("models") + '<p class="news-menu-label">Model</p><div class="harness-models" data-model-list role="listbox" aria-label="Models">' + rows + '<p class="model-menu-empty" data-menu-nomatch hidden>No models match.</p></div>';
  }

  // Effort for this thread, next to the model: the levels its model takes
  // (Claude Code, Cursor, Droid, OpenCode, pi). A running agent reports its
  // own; otherwise they come from the levels JAgents has seen for that agent
  // and model. "Default" leaves effort to the agent. A new thread keeps the
  // pick until its chat exists.
  effortData() {
    const id = this.currentAgentId();
    const e = (this.snap && this.snap.effort) || {};
    if (e.live) return e;
    const all = (store.modelCache[id] || {}).efforts || null;
    const model = this.modelInfo(id).selected || "";
    const levels = all ? all[model] || all["*"] || [] : e.levels || [];
    return { levels, current: "", via: "", pref: this.snap ? e.pref || "" : this.pendingEffort || "", live: false, known: Boolean(all || e.known) };
  }

  effortLabel() {
    const e = this.effortData();
    const v = e.current || e.pref || "";
    const level = (e.levels || []).find((l) => l.value === v);
    return v ? effortName(v, level && level.name) : "Default";
  }

  paintEffort() {
    const slot = this.el.querySelector("[data-effort]");
    if (!slot) return;
    const e = this.effortData();
    const id = this.currentAgentId();
    const agent = store.acpAgents.find((a) => a.id === id);
    // Levels not known for this agent yet: ask once (a short probe).
    if (!e.known && agent && agent.available && !effortAsked.has(id)) {
      effortAsked.add(id);
      refreshModelInfo(id);
    }
    const show = (e.levels || []).length > 0;
    if (slot.hidden === show) slot.hidden = !show;
    if (!show) return this.closeEffort();
    const label = this.effortLabel();
    const title = this.busy() ? "Wait for this turn to finish, or press Stop, to change effort." : "Effort for this thread: " + label + (e.live ? "" : ". Applies when the agent starts.");
    const html =
      '<button type="button" class="news-pill harness-toggle effort-toggle" data-effort-toggle aria-label="Effort: ' + esc(label) + '" aria-haspopup="listbox" aria-expanded="false" title="' + esc(title) + '"' + (this.busy() ? " disabled" : "") + ">" +
      icon("gauge", 15) + '<span class="news-pill-label">' + esc(label) + "</span>" + icon("chevronDown", 12) + "</button>";
    if (slot._html === html) return;
    slot._html = html;
    const toggle = slot.querySelector("[data-effort-toggle]");
    if (!toggle) {
      slot.innerHTML = html + "<div data-effort-popup></div>";
      return;
    }
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const next = tpl.content.firstElementChild;
    for (const a of Array.from(toggle.attributes)) if (!next.hasAttribute(a.name)) toggle.removeAttribute(a.name);
    for (const a of Array.from(next.attributes)) if (a.name !== "aria-expanded") toggle.setAttribute(a.name, a.value);
    toggle.innerHTML = next.innerHTML;
  }

  openEffort() {
    if (this.el.querySelector("[data-effort-menu]")) return this.closeEffort();
    this.closeMenus();
    const e = this.effortData();
    const cur = e.pref || "";
    const row = (value, name, desc) => {
      const picked = value === cur;
      return (
        '<button type="button" role="option" class="news-menu-row' + (picked ? " is-selected" : "") + '" data-effort-pick="' + esc(value) + '" aria-selected="' + picked + '">' +
        '<span class="news-menu-text"><span class="news-menu-name">' + esc(name) + "</span>" + (desc ? '<span class="news-menu-desc">' + esc(desc) + "</span>" : "") + "</span>" + (picked ? CHECK : "") + "</button>"
      );
    };
    const running = e.live && e.current ? effortName(e.current, ((e.levels || []).find((l) => l.value === e.current) || {}).name) : "";
    const popup = this.el.querySelector("[data-effort-popup]");
    popup.innerHTML =
      '<div class="news-menu effort-menu" data-effort-menu role="dialog" aria-label="Effort">' +
      '<p class="news-menu-label">Effort for this thread</p><div data-model-list role="listbox" aria-label="Effort levels">' +
      row("", "Default", "The agent's own" + (running && !cur ? " (now " + running + ")" : "")) +
      (e.levels || []).map((l) => row(l.value, effortName(l.value, l.name))).join("") +
      "</div>" +
      (e.live ? "" : '<p class="menu-note">' + (this.chatId ? "The agent is not running. Your pick applies when it starts." : "Applies when you send the first message.") + "</p>") +
      "</div>";
    this.el.querySelector("[data-effort-toggle]").setAttribute("aria-expanded", "true");
    const sel = popup.querySelector('[aria-selected="true"]') || popup.querySelector(".news-menu-row");
    if (sel) sel.focus();
  }

  closeEffort() {
    const menu = this.el.querySelector("[data-effort-menu]");
    if (menu) menu.remove();
    const toggle = this.el.querySelector("[data-effort-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
  }

  async chooseEffort(level) {
    this.closeEffort();
    if (!this.chatId) {
      this.pendingEffort = level;
      this.paintEffort();
    } else {
      const wasLive = this.effortData().live;
      try {
        this.setSnap(await window.jagents.chats.setEffort(this.chatId, level));
        if (!level && wasLive) toast("Default effort applies when the agent starts again.");
      } catch (error) {
        toast(errorText(error));
      }
    }
    const t = this.el.querySelector("[data-effort-toggle]");
    if (t) t.focus();
  }

  paintToggles() {
    this.paintEffort();
    this.paintPerm();
    this.paintCtx();
    const slot = this.el.querySelector("[data-picker]");
    const html = this.pickerToggleMarkup();
    if (!slot || slot._html === html) return;
    slot._html = html;
    const toggle = slot.firstElementChild;
    if (!toggle || !slot.querySelector("[data-picker-popup]")) {
      slot.innerHTML = html + "<div data-picker-popup></div>";
      return;
    }
    // Update the toggle in place. Swapping the button while it is pressed
    // (a model list or status arriving mid-click) sends the click to the
    // slot instead, and the menu never opens.
    const tpl = document.createElement("template");
    tpl.innerHTML = html;
    const next = tpl.content.firstElementChild;
    for (const a of Array.from(toggle.attributes)) if (!next.hasAttribute(a.name)) toggle.removeAttribute(a.name);
    for (const a of Array.from(next.attributes)) if (a.name !== "aria-expanded") toggle.setAttribute(a.name, a.value);
    toggle.innerHTML = next.innerHTML;
  }

  closeMenus() {
    const menu = this.el.querySelector("[data-picker-menu]");
    if (menu) menu.remove();
    const toggle = this.el.querySelector("[data-picker-toggle]");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    this.viewHarness = "";
  }

  // Loads an agent's model list the first time the picker shows it.
  ensureModels(id) {
    const agent = store.acpAgents.find((a) => a.id === id);
    if (!agent || !agent.available) return;
    const info = this.modelInfo(id);
    if (!info.list.length && !info.probing && !info.error) refreshModelInfo(id);
  }

  openMenu() {
    if (this.el.querySelector("[data-picker-menu]")) return this.closeMenus();
    this.viewHarness = this.currentAgentId();
    this.ensureModels(this.viewHarness);
    const popup = this.el.querySelector("[data-picker-popup]");
    popup.innerHTML = this.pickerMenuMarkup();
    this.el.querySelector("[data-picker-toggle]").setAttribute("aria-expanded", "true");
    const menu = popup.querySelector("[data-picker-menu]");
    const selected = menu.querySelector('[data-model-list] [aria-selected="true"]');
    if (selected) selected.scrollIntoView({ block: "nearest" });
    const focus = menu.querySelector("[data-menu-search]") || selected || menu.querySelector(".harness-tab.is-active");
    if (focus) focus.focus();
  }

  viewAgent(id) {
    if (!store.acpAgents.some((a) => a.id === id)) return;
    this.viewHarness = id;
    this.ensureModels(id);
    this.repaintMenu();
  }

  async pickAgent(id) {
    const bound = Boolean(this.snap && this.snap.transcript && this.snap.transcript.length);
    const agent = store.acpAgents.find((a) => a.id === id);
    if (!agent) return false;
    if (this.snap && id !== this.snap.harnessId) {
      if (!agent.available) {
        toast("Install " + agent.name + " before switching this chat to it.");
        return false;
      }
      try {
        this.snap = await window.jagents.chats.handoff(this.snap.chatId, id);
        refreshChats();
        if (bound) toast(agent.name + " has this chat now, with the messages and tool calls so far.");
      } catch (error) {
        toast(errorText(error));
        return false;
      }
    } else if (!this.snap) {
      this.newAgent = id;
    }
    refreshModelInfo(id);
    this.paint();
    return true;
  }

  async pickModel(modelId) {
    try {
      const id = this.currentAgentId();
      if (this.snap) {
        this.snap = await window.jagents.chats.setModel(this.snap.chatId, modelId);
        // Not started yet: the host saved it as this agent's model for the next start.
        const live = this.snap && this.snap.models && this.snap.models.availableModels.length;
        if (!live) store.modelCache[id] = Object.assign({}, store.modelCache[id], { preferred: modelId });
      } else store.modelCache[id] = await window.jagents.agents.setModel(id, modelId);
    } catch (error) {
      toast(errorText(error));
    }
    this.paint();
  }

  // A model row: switches agent first when it belongs to another one.
  async choose(harnessId, modelId) {
    this.closeMenus();
    if (harnessId !== this.currentAgentId() && !(await this.pickAgent(harnessId))) return;
    if (modelId) await this.pickModel(modelId);
    this.input.focus();
  }

  // ---- Attachments --------------------------------------------------------

  async addFiles(files) {
    const list = Array.from(files || []);
    for (const file of list) {
      if (this.pending.length >= ATTACH_MAX) {
        toast("Attach up to " + ATTACH_MAX + " files per message.");
        break;
      }
      if (file.size > ATTACH_BYTES) {
        toast(file.name + " is over 50 MB.");
        continue;
      }
      const path = window.jagents.pathForFile(file);
      const item = { key: Math.random().toString(36).slice(2), name: file.name || "pasted.png", mimeType: file.type || "", size: file.size, path };
      try {
        const image = IMAGE_RE.test(item.mimeType);
        // Pasted screenshots have no file on disk, so their bytes go along.
        if (!path) item.data = await readDataUrl(file);
        if (image && file.size <= PREVIEW_BYTES) item.preview = item.data || (await readDataUrl(file));
      } catch (error) {
        toast(errorText(error));
        continue;
      }
      if (this.destroyed) return;
      this.pending.push(item);
    }
    this.paintTray();
  }

  async attachFromDialog() {
    try {
      const paths = await window.jagents.pickFiles();
      if (!paths.length) return;
      for (const p of paths) {
        if (this.pending.length >= ATTACH_MAX) {
          toast("Attach up to " + ATTACH_MAX + " files per message.");
          break;
        }
        this.pending.push({ key: Math.random().toString(36).slice(2), name: p.split(/[\\/]/).pop(), mimeType: "", size: 0, path: p });
      }
      this.paintTray();
      this.input.focus();
    } catch (error) {
      toast(errorText(error));
    }
  }

  paintTray() {
    const tray = this.el.querySelector("[data-tray]");
    tray.hidden = !this.pending.length;
    tray.innerHTML = this.pending
      .map((p) => {
        const thumb = p.preview ? '<img src="' + esc(p.preview) + '" alt="">' : icon("file", 16);
        return (
          '<div class="att-chip' + (p.preview ? " is-image" : "") + '" title="' + esc(p.path || p.name) + '">' + thumb +
          '<span class="att-name">' + esc(p.name) + "</span>" +
          '<button type="button" class="att-remove" data-unattach="' + esc(p.key) + '" aria-label="Remove ' + esc(p.name) + '">' + icon("close", 12) + "</button></div>"
        );
      })
      .join("");
  }

  async send() {
    const text = this.input.value.trim();
    const pending = this.pending.slice();
    if (!text && !pending.length) return;
    try {
      if (!this.chatId) {
        const agent = store.acpAgents.find((a) => a.id === this.newAgent);
        if (agent && !agent.available) return toast(agent.name + " is not installed. " + (agent.install || ""));
        this.snap = await window.jagents.chats.create({ harnessId: this.newAgent });
        this.chatId = this.snap.chatId;
        if (this.pendingEffort) this.snap = await window.jagents.chats.setEffort(this.chatId, this.pendingEffort);
        this.pendingEffort = "";
        if (this.pendingPerm) this.snap = await window.jagents.chats.setPermissionMode(this.chatId, this.pendingPerm);
        this.pendingPerm = "";
        window.jagents.chats.setDraft("new", "").catch(() => {});
        if (this.opts.onCreated) this.opts.onCreated(this.chatId);
        refreshChats();
      }
      this.input.value = "";
      autoGrow(this.input);
      this.pending = [];
      this.paintTray();
      this.recall = -1;
      this.closeAc();
      this.saveDraft(true);
      const input0 = pending.length ? { text, attachments: pending.map((p) => (p.path ? { name: p.name, mimeType: p.mimeType, path: p.path } : { name: p.name, mimeType: p.mimeType, data: p.data })) } : text;
      // Mid-turn: the host queues it and the queue card shows it.
      if (this.busy()) {
        this.setSnap(await window.jagents.chats.prompt(this.chatId, input0));
        return;
      }
      this.forceScroll = true;
      this.markerKey = "";
      const shown = pending.map((p) => ({ name: p.name, mimeType: p.mimeType, size: p.size, path: p.path, preview: p.preview }));
      this.snap = Object.assign({}, this.snap, { status: this.snap.status === "ready" ? "busy" : "starting", transcript: this.snap.transcript.concat([{ id: "local-" + Date.now(), role: "user", text, attachments: shown }]) });
      this.paint();
      const done = await window.jagents.chats.prompt(this.chatId, input0);
      if (done && views.has(this)) this.setSnap(done);
    } catch (error) {
      toast(errorText(error));
      if (this.chatId && views.has(this)) this.setSnap(await window.jagents.chats.get(this.chatId));
    }
  }

  wire() {
    const el = this.el;
    const sig = { signal: this.abort.signal };
    el.addEventListener("click", (event) => {
      const t = event.target;
      if (t.closest("[data-picker-toggle]")) {
        event.stopPropagation();
        this.closeEffort();
        return this.openMenu();
      }
      if (t.closest("[data-effort-toggle]")) {
        event.stopPropagation();
        this.closePerm();
        return this.openEffort();
      }
      if (t.closest("[data-perm-toggle]")) {
        event.stopPropagation();
        return this.openPerm();
      }
      const permPick = t.closest("[data-perm-pick]");
      if (permPick) return this.choosePerm(permPick.dataset.permPick);
      if (t.closest("[data-open-perm-mode]")) {
        event.stopPropagation();
        return this.openPerm();
      }
      const answer = t.closest("[data-perm-answer]");
      if (answer) return this.answerPermission(answer.dataset.permAnswer, answer.dataset.permOption);
      const acPick = t.closest("[data-ac-pick]");
      if (acPick) return this.pickAc(Number(acPick.dataset.acPick));
      if (t.closest("[data-retry]")) return this.retry();
      if (t.closest("[data-jump]")) return this.jumpToLatest();
      const qe = t.closest("[data-queue-edit]");
      if (qe) return this.editQueued(qe.dataset.queueEdit);
      const qs = t.closest("[data-queue-save]");
      if (qs) return this.saveQueued(qs.dataset.queueSave);
      if (t.closest("[data-queue-cancel]")) {
        this.el.querySelector("[data-queue]")._html = "";
        const ta = this.el.querySelector("[data-queue-input]");
        if (ta) ta.removeAttribute("data-queue-input");
        return this.paintQueue();
      }
      const qr = t.closest("[data-queue-remove]");
      if (qr) return this.removeQueued(qr.dataset.queueRemove);
      if (t.closest("[data-find-next]")) return this.runFind(false, 1);
      if (t.closest("[data-find-prev]")) return this.runFind(false, -1);
      if (t.closest("[data-find-close]")) return this.closeFind();
      const sub = t.closest("[data-open-chat]");
      if (sub) return fire("open-chat", sub.dataset.openChat);
      // A plugin subagent opens as a thread over this chat; Back returns.
      const ps = t.closest("[data-open-sub]");
      if (ps) return this.openSub(ps.dataset.openSub);
      if (t.closest("[data-sub-back]")) return this.closeSub();
      const link = t.closest(".bubble a[href]");
      if (link) {
        event.preventDefault();
        const href = link.getAttribute("href") || "";
        if (/^https:\/\//i.test(href)) window.jagents.openUrl(href).catch((e) => toast(errorText(e)));
        else if (/^http:\/\//i.test(href)) toast("Only https links open from a chat.");
        return;
      }
      const effortPick = t.closest("[data-effort-pick]");
      if (effortPick) return this.chooseEffort(effortPick.dataset.effortPick);
      const tab = t.closest("[data-harness-tab]");
      if (tab) return this.viewAgent(tab.dataset.harnessTab);
      if (t.closest("[data-open-market]")) {
        this.closeMenus();
        return openMarketplace();
      }
      const modelPick = t.closest("[data-model-pick]");
      if (modelPick) return this.choose(modelPick.dataset.modelAgent, modelPick.dataset.modelPick);
      if (t.closest("[data-attach]")) return this.attachFromDialog();
      const un = t.closest("[data-unattach]");
      if (un) {
        this.pending = this.pending.filter((p) => p.key !== un.dataset.unattach);
        this.paintTray();
        return this.input.focus();
      }
      const auth = t.closest("[data-auth]");
      if (auth) return this.signIn(auth.dataset.auth);
      const file = t.closest("[data-open-file]");
      if (file) {
        // A chip inside a row's summary opens the file, not the row.
        event.preventDefault();
        return window.jagents.openPath(file.dataset.openFile);
      }
      if (t.closest("[data-send]")) return this.send();
      if (t.closest("[data-stop]") && this.chatId) return this.stop();
      if (!t.closest(".news-menu")) {
        this.closeMenus();
        this.closeEffort();
        this.closePerm();
        this.closeAc();
      }
    }, sig);
    el.addEventListener(
      "toggle",
      (event) => {
        const d = event.target;
        if (d.matches && d.matches("details[data-tool]")) this.toolOpen.set(d.dataset.tool, d.open);
        else if (d.matches && d.matches("details[data-thought]")) {
          if (d.open) this.openThoughts.add(d.dataset.thought);
          else this.openThoughts.delete(d.dataset.thought);
        }
      },
      { capture: true, signal: this.abort.signal },
    );
    el.addEventListener("input", (event) => {
      const search = event.target.closest("[data-menu-search]");
      if (search) applyFilter(search.closest(".news-menu").querySelector("[data-model-list]"), search.value);
      if (event.target.matches("[data-find-input]")) this.runFind(true);
    }, sig);
    el.addEventListener("focusin", () => (lastView = this), sig);
    el.addEventListener("pointerdown", () => (lastView = this), sig);
    el.querySelector(".transcript").addEventListener("scroll", () => this.onScroll(), { passive: true, signal: this.abort.signal });
    el.addEventListener("keydown", (event) => {
      if (event.target.matches && event.target.matches("[data-find-input]")) {
        if (event.key === "Enter") {
          event.preventDefault();
          return this.runFind(false, event.shiftKey ? -1 : 1);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          return this.closeFind();
        }
        return;
      }
      if (event.target.matches && event.target.matches("[data-queue-input]")) {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          return this.saveQueued(event.target.dataset.queueInput);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          el.querySelector("[data-queue]")._html = "";
          event.target.removeAttribute("data-queue-input");
          this.paintQueue();
          return this.input.focus();
        }
        return;
      }
      if (event.key === "Escape" && el.querySelector(".news-menu:not([data-ac])")) {
        event.preventDefault();
        this.closeMenus();
        this.closeEffort();
        this.closePerm();
        return this.input.focus();
      }
      if (event.key === "Escape" && this.findOpen()) {
        event.preventDefault();
        return this.closeFind();
      }
      if (event.key === "Escape" && this.subOpen) {
        event.preventDefault();
        return this.closeSub();
      }
      // Esc stops the turn.
      if (event.key === "Escape" && !this.ac && this.busy()) {
        event.preventDefault();
        return this.stop();
      }
      const inSearch = event.target.matches && event.target.matches("[data-menu-search]");
      if (inSearch && event.key === "Enter") {
        event.preventDefault();
        const first = event.target.closest(".news-menu").querySelector("[data-model-list] .news-menu-row:not([hidden])");
        if (first) first.click();
        return;
      }
      const tab = event.target.closest && event.target.closest("[data-harness-tab]");
      if (tab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const tabs = Array.from(tab.parentElement.querySelectorAll("[data-harness-tab]"));
        const i = tabs.indexOf(tab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next].focus();
        return this.viewAgent(tabs[next].dataset.harnessTab);
      }
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      const menu = event.target.closest && event.target.closest(".news-menu");
      if (!menu) return;
      event.preventDefault();
      const rows = Array.from(menu.querySelectorAll("[data-menu-search], [data-model-list] .news-menu-row:not([hidden])"));
      if (!rows.length) return;
      const i = rows.indexOf(document.activeElement);
      rows[(i + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
    }, sig);
    // composedPath, not contains: a harness tab redraws the menu on click, so
    // by now the clicked button is no longer in the page.
    document.addEventListener("click", (event) => {
      if (!event.composedPath().includes(el)) {
        this.closeMenus();
        this.closeEffort();
        this.closePerm();
      }
    }, sig);
    // Files dropped anywhere on the chat are attached.
    const overlay = el.querySelector("[data-drop]");
    let depth = 0;
    const hasFiles = (event) => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files");
    el.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth++;
      overlay.hidden = false;
    }, sig);
    el.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }, sig);
    el.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    }, sig);
    el.addEventListener("drop", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      overlay.hidden = true;
      this.addFiles(event.dataTransfer.files);
      this.input.focus();
    }, sig);
    // Pasted files and screenshots are attached; pasted text still pastes.
    this.input.addEventListener("paste", (event) => {
      const files = event.clipboardData ? Array.from(event.clipboardData.files || []) : [];
      if (!files.length) return;
      if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();
      this.addFiles(files);
    }, sig);
    this.input.addEventListener("keydown", (event) => {
      if (this.ac) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          return this.moveAc(event.key === "ArrowDown" ? 1 : -1);
        }
        if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
          event.preventDefault();
          return this.pickAc();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          return this.closeAc();
        }
      }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
        return;
      }
      const at0 = this.input.selectionStart === 0 && this.input.selectionEnd === 0;
      const atEnd = this.input.selectionStart === this.input.value.length;
      if (event.key === "ArrowUp" && !event.shiftKey && at0 && (this.recall >= 0 || !this.input.value)) {
        if (this.recallStep(-1)) event.preventDefault();
      } else if (event.key === "ArrowDown" && !event.shiftKey && atEnd && this.recall >= 0) {
        if (this.recallStep(1)) event.preventDefault();
      }
    }, sig);
    this.input.addEventListener("input", () => {
      autoGrow(this.input);
      this.recall = -1;
      this.saveDraft();
      this.updateAc();
    }, sig);
    this.input.addEventListener("blur", () => setTimeout(() => !this.el.contains(document.activeElement) && this.closeAc(), 150), sig);
  }
}
