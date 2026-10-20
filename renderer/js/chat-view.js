// A chat thread: transcript plus the docked composer card. The composer takes
// text and attachments (paste, drop, or the paperclip), and one picker chooses
// the agent and its model: agent logos across the top, that agent's models
// below. Picking another agent on a bound chat hands the chat over. Code mode
// shows several of these at once and Thread mode shows one large.

import { esc, toast, errorText, markdown } from "./util.js";
import { harnessIcon, icon } from "./icons.js";
import { store, on, refreshModelInfo, mergeModelInfo, refreshChats } from "./store.js";
import { openMarketplace } from "./marketplace.js";

const views = new Set();

export function routeAcpState(snap) {
  if (snap.models && snap.models.availableModels.length) {
    store.modelCache[snap.harnessId] = Object.assign({ preferred: "" }, store.modelCache[snap.harnessId], { models: snap.models });
  }
  for (const v of views) if (v.chatId === snap.chatId) v.setSnap(snap);
}

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

function toolIcon(st) {
  return st === "completed" ? icon("check", 14) : st === "failed" || st === "cancelled" ? icon("close", 14) : '<span class="spinner sm"></span>';
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
    this.openTools = new Set();
    // Files waiting in the composer: {key, name, mimeType, size, path | data, preview}.
    this.pending = [];
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
      '<div class="transcript"><div class="transcript-inner"></div></div>' +
      '<div class="composer-wrap"><div class="composer-inner">' +
      '<form class="composer-card" data-form>' +
      '<div class="attach-tray" data-tray hidden></div>' +
      '<div class="composer-input-wrap"><textarea data-input rows="1" placeholder="' + esc(this.opts.placeholder || "Message the agent") + '"></textarea></div>' +
      '<p class="muted small composer-hint" data-hint></p>' +
      '<div class="composer-foot"><div class="composer-settings">' +
      '<button type="button" class="news-pill attach-btn" data-attach aria-label="Attach files" title="Attach files. You can also paste or drop them here.">' + icon("paperclip", 16) + "</button>" +
      '<div class="harness-picker" data-picker></div></div>' +
      '<p class="composer-keys" aria-hidden="true"><kbd>Enter</kbd> send <span>·</span> <kbd>Shift</kbd>+<kbd>Enter</kbd> new line</p><div class="composer-submit">' +
      '<button type="button" class="send-btn stop" data-stop hidden>' + icon("stop", 12) + "<span>Stop</span></button>" +
      '<button type="button" class="send-btn" data-send aria-label="Send">' + icon("arrowUp", 16) + "</button>" +
      "</div></div></form></div></div>" +
      '<div class="drop-overlay" data-drop hidden>' + icon("paperclip", 22) + "<span>Drop files to attach</span></div>";
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
    const id = this.currentAgentId();
    const cached = store.modelCache[id];
    if (!(cached && cached.models && cached.models.availableModels && cached.models.availableModels.length) && !(cached && cached.probing)) refreshModelInfo(id);
  }

  destroy() {
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
    if (row.role === "thought") return '<details class="thought"><summary>Thinking</summary><div>' + esc(row.text) + "</div></details>";
    if (row.role === "tool") {
      const st = row.status || "pending";
      const key = row.toolCallId || "row-" + index;
      const detail = row.input || row.output;
      const head = toolIcon(st) + '<span class="grow">' + esc(row.title) + "</span>" + (row.kind ? '<span class="tool-kind">' + esc(row.kind) + "</span>" : "");
      if (!detail) return '<div class="tool ' + esc(st) + '">' + head + "</div>";
      return (
        '<details class="tool ' + esc(st) + '" data-tool="' + esc(key) + '"' + (this.openTools.has(key) ? " open" : "") + "><summary>" + head + "</summary>" +
        (row.input ? '<div class="tool-io"><span>Input</span><pre>' + esc(row.input) + "</pre></div>" : "") +
        (row.output ? '<div class="tool-io"><span>Output</span><pre>' + esc(row.output) + "</pre></div>" : "") +
        "</details>"
      );
    }
    if (row.role === "plan") {
      return '<div class="plan"><strong>Plan</strong>' + (row.entries || []).map((e) => '<div class="plan-row ' + (e.status === "completed" ? "done" : esc(e.status)) + '"><span class="plan-dot"></span>' + esc(e.content) + "</div>").join("") + "</div>";
    }
    if (row.role === "error") return '<div class="err-row">' + esc(row.text) + "</div>";
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
    if (!rows.length) inner.innerHTML = this.introMarkup();
    else {
      const working = this.snap.status === "busy" ? '<div class="working"><span class="spinner"></span>' + esc(this.snap.agentName || "Agent") + " is working…</div>" : this.snap.status === "starting" ? '<div class="working"><span class="spinner"></span>' + (this.signingIn ? "Signing in to " + esc(this.snap.agentName || "the agent") + "… If a browser window opened, finish signing in there." : "Starting " + esc(this.snap.agentName || "agent") + "…") + "</div>" : "";
      inner.innerHTML = rows.map((r, i) => this.rowMarkup(r, i)).join("") + working + (this.snap.status === "error" && this.snap.error ? this.errorMarkup() : "");
    }
    if (pinned || this.forceScroll) scroller.scrollTop = scroller.scrollHeight;
    this.forceScroll = false;
    this.paintToggles();
    const agent = this.currentAgent();
    const hint = this.el.querySelector("[data-hint]");
    hint.textContent = agent && !agent.available ? agent.name + " is not installed. " + (agent.install || "") : "";
    const busy = this.busy();
    this.el.querySelector("[data-send]").hidden = busy;
    this.el.querySelector("[data-stop]").hidden = !busy;
    if (this.opts.onChange) this.opts.onChange(this.snap);
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
          '<button type="button" role="tab" class="harness-tab' + (active ? " is-active" : "") + (a.id === current ? " is-current" : "") + (a.available ? "" : " is-missing") + '" data-harness-tab="' + esc(a.id) + '" aria-selected="' + active + '" tabindex="' + (active ? "0" : "-1") + '" title="' + esc(a.name + state) + '" aria-label="' + esc(a.name + state) + '">' +
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

  paintToggles() {
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
        if (this.opts.onCreated) this.opts.onCreated(this.chatId);
        refreshChats();
      }
      this.input.value = "";
      autoGrow(this.input);
      this.pending = [];
      this.paintTray();
      this.forceScroll = true;
      const shown = pending.map((p) => ({ name: p.name, mimeType: p.mimeType, size: p.size, path: p.path, preview: p.preview }));
      this.snap = Object.assign({}, this.snap, { status: this.snap.status === "ready" ? "busy" : "starting", transcript: this.snap.transcript.concat([{ role: "user", text, attachments: shown }]) });
      this.paint();
      const input = pending.length ? { text, attachments: pending.map((p) => (p.path ? { name: p.name, mimeType: p.mimeType, path: p.path } : { name: p.name, mimeType: p.mimeType, data: p.data })) } : text;
      const done = await window.jagents.chats.prompt(this.chatId, input);
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
        return this.openMenu();
      }
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
      if (file) return window.jagents.openPath(file.dataset.openFile);
      if (t.closest("[data-send]")) return this.send();
      if (t.closest("[data-stop]") && this.chatId) return window.jagents.chats.cancel(this.chatId);
      if (!t.closest(".news-menu")) this.closeMenus();
    }, sig);
    el.addEventListener(
      "toggle",
      (event) => {
        const d = event.target;
        if (d.matches && d.matches("details[data-tool]")) {
          if (d.open) this.openTools.add(d.dataset.tool);
          else this.openTools.delete(d.dataset.tool);
        }
      },
      { capture: true, signal: this.abort.signal },
    );
    el.addEventListener("input", (event) => {
      const search = event.target.closest("[data-menu-search]");
      if (search) applyFilter(search.closest(".news-menu").querySelector("[data-model-list]"), search.value);
    }, sig);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && el.querySelector(".news-menu")) {
        event.preventDefault();
        this.closeMenus();
        return this.input.focus();
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
      if (!event.composedPath().includes(el)) this.closeMenus();
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
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    }, sig);
    this.input.addEventListener("input", () => autoGrow(this.input), sig);
  }
}
