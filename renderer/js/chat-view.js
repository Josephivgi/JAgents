// A chat thread with Plugin App's composer: the docked composer card, Agent and
// Model pills with searchable upward menus, Enter to send, Stop while a turn
// runs, and the agent pill doing a context handoff on a bound chat. Adapted
// from plugin-app/renderer/js/build.js into a component so Code mode can show
// several chats at once and Thread mode can show one large.

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
  for (const v of views) if (v.currentAgentId() === info.harnessId) v.onModels();
}

on("models", (id) => {
  for (const v of views) if (v.currentAgentId() === id) v.paintToggles();
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

function elapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  return m < 60 ? m + "m " + (s % 60) + "s" : Math.floor(m / 60) + "h " + (m % 60) + "m";
}

async function copyText(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (error) {
    return toast(errorText(error));
  }
  btn.innerHTML = icon("check", 13);
  btn.classList.add("done");
  setTimeout(() => {
    btn.innerHTML = icon("copy", 13);
    btn.classList.remove("done");
  }, 1200);
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
      '<div class="composer-input-wrap"><textarea data-input rows="1" placeholder="' + esc(this.opts.placeholder || "Message the agent") + '"></textarea></div>' +
      '<p class="muted small composer-hint" data-hint></p>' +
      '<div class="composer-foot"><div class="composer-settings"><div class="ai-harness-picker" data-agent-picker></div><div class="agent-model-picker" data-model-picker></div></div>' +
      '<div class="composer-submit">' +
      '<button type="button" class="send-btn stop" data-stop aria-label="Stop" title="Stop" hidden>' + icon("stop", 12) + "</button>" +
      '<button type="button" class="send-btn" data-send aria-label="Send">' + icon("arrowUp", 16) + "</button>" +
      "</div></div></form></div></div>";
    this.input = this.el.querySelector("[data-input]");
    this.turnStart = 0;
    // Counts up the "working" line between repaints.
    this.timer = setInterval(() => {
      const span = this.turnStart && this.el.querySelector("[data-elapsed]");
      if (span) span.textContent = elapsed(Date.now() - this.turnStart);
    }, 1000);
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
    clearInterval(this.timer);
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
    const popup = this.el.querySelector("[data-model-popup]");
    if (popup && popup.querySelector("[data-model-menu]")) {
      const old = popup.querySelector("[data-menu-search]");
      const query = old ? old.value : "";
      popup.innerHTML = this.modelMenuMarkup();
      const inp = popup.querySelector("[data-menu-search]");
      if (inp && query) {
        inp.value = query;
        applyFilter(popup.querySelector("[data-model-menu]"), query);
      }
    }
  }

  currentAgentId() {
    return this.snap ? this.snap.harnessId : this.newAgent;
  }

  currentAgent() {
    const id = this.currentAgentId();
    return store.acpAgents.find((a) => a.id === id) || { id, name: id || "Agent", available: false };
  }

  modelInfo() {
    const snap = this.snap;
    if (snap && snap.models && snap.models.availableModels.length) return { list: snap.models.availableModels, selected: snap.models.currentModelId, live: true };
    const cached = store.modelCache[this.currentAgentId()] || {};
    const models = cached.models || {};
    if (models.availableModels && models.availableModels.length) return { list: models.availableModels, selected: cached.preferred || models.currentModelId, live: false };
    return { list: [], selected: "", live: false, probing: Boolean(cached.probing), error: cached.error || "" };
  }

  busy() {
    return Boolean(this.snap && (this.snap.status === "busy" || this.snap.status === "starting"));
  }

  rowMarkup(row, index) {
    const actions = '<div class="msg-actions"><button type="button" class="copy-btn" data-copy-row="' + index + '" title="Copy message" aria-label="Copy message">' + icon("copy", 13) + "</button></div>";
    if (row.role === "user") {
      const from = row.from ? '<span class="from-tag">' + icon("hub", 12) + esc(row.from) + "</span>" : "";
      return '<div class="msg user' + (row.from ? " relayed" : "") + '">' + from + '<div class="bubble">' + esc(row.text) + "</div>" + actions + "</div>";
    }
    if (row.role === "agent") return '<div class="msg agent"><div class="bubble">' + markdown(row.text) + "</div>" + actions + "</div>";
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
    if (!this.busy()) this.turnStart = 0;
    else if (!this.turnStart) this.turnStart = Date.now();
    if (!rows.length) inner.innerHTML = this.introMarkup();
    else {
      const working = this.snap.status === "busy" ? '<div class="working"><span class="spinner"></span>' + esc(this.snap.agentName || "Agent") + ' is working… <span class="elapsed" data-elapsed>' + elapsed(Date.now() - this.turnStart) + "</span></div>" : this.snap.status === "starting" ? '<div class="working"><span class="spinner"></span>' + (this.signingIn ? "Signing in to " + esc(this.snap.agentName || "the agent") + "… If a browser window opened, finish signing in there." : "Starting " + esc(this.snap.agentName || "agent") + "…") + "</div>" : "";
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

  agentToggleMarkup() {
    const agent = this.currentAgent();
    const bound = Boolean(this.snap && this.snap.transcript && this.snap.transcript.length);
    return (
      '<button type="button" class="news-pill ai-harness-toggle" data-agent-toggle aria-label="Choose agent" aria-haspopup="dialog" aria-expanded="false"' +
      (this.busy() ? ' title="Wait for this turn to finish, or press Stop, to switch agents." disabled' : bound ? ' title="Picking another agent hands this chat to it, with the conversation so far."' : "") + ">" +
      harnessIcon(agent.id, 15) + '<span class="ai-harness-name">' + esc(agent.name) + "</span>" + icon("chevronDown", 12) + "</button>"
    );
  }

  agentMenuMarkup() {
    const current = this.currentAgentId();
    const bound = Boolean(this.snap && this.snap.transcript && this.snap.transcript.length);
    const rows = store.acpAgents
      .map((a) => {
        const picked = a.id === current;
        return (
          '<button type="button" role="option" class="news-menu-row agent-row' + (picked ? " is-selected" : "") + (a.available ? "" : " is-missing") + '" data-agent-pick="' + esc(a.id) + '" data-menu-text="' + esc((a.name + " " + a.id).toLowerCase()) + '" aria-selected="' + picked + '">' +
          harnessIcon(a.id, 16) + '<span class="news-menu-text"><span class="news-menu-name">' + esc(a.name) + '</span><span class="news-menu-desc">' + esc(a.available ? a.description : a.install) + "</span></span>" +
          (a.available ? "" : '<span class="agent-badge">Not installed</span>') + (picked ? CHECK : "") + "</button>"
        );
      })
      .join("");
    return (
      '<div class="news-menu ai-harness-menu" data-agent-menu role="dialog" aria-label="Agent">' + searchMarkup("agents") +
      (bound ? '<p class="menu-note">' + icon("handoff", 12) + "Switching hands this chat to the new agent with its recent messages and tool calls.</p>" : "") +
      '<div role="listbox" aria-label="Agents">' + rows + '<p class="model-menu-empty" data-menu-nomatch hidden>No agents match.</p></div>' +
      '<button type="button" class="news-menu-row market-menu-row" data-open-market>' + icon("store", 16) + '<span class="news-menu-text"><span class="news-menu-name">Get more agents…</span><span class="news-menu-desc">Install agents from the marketplace</span></span></button></div>'
    );
  }

  modelToggleMarkup() {
    const snap = this.snap;
    const info = this.modelInfo();
    const model = info.list.find((m) => m.modelId === info.selected);
    const agent = this.currentAgent();
    const label = model ? model.name || model.modelId : (snap && snap.status === "starting") || info.probing ? "Loading…" : info.error ? "Default" : !agent.available ? "Not installed" : info.selected || "Default";
    return '<button type="button" class="news-pill agent-model-toggle" data-model-toggle aria-label="Choose model" aria-haspopup="dialog" aria-expanded="false"' + (this.busy() ? ' title="Wait for this turn to finish, or press Stop, to change the model." disabled' : "") + '><span class="news-pill-label">' + esc(label) + "</span>" + icon("chevronDown", 12) + "</button>";
  }

  modelMenuMarkup() {
    const snap = this.snap;
    const info = this.modelInfo();
    const agent = this.currentAgent();
    const empty = (snap && snap.status === "starting") || info.probing ? "Loading its models…" : info.error ? info.error : !agent.available ? agent.name + " is not installed." : "This agent did not advertise selectable models. It uses its own default.";
    const rows = info.list
      .map(
        (m) =>
          '<button type="button" class="news-menu-row' + (m.modelId === info.selected ? " is-selected" : "") + '" role="option" data-model-pick="' + esc(m.modelId) + '" data-menu-text="' + esc(((m.name || "") + " " + m.modelId + " " + (m.description || "")).toLowerCase()) + '" aria-selected="' + (m.modelId === info.selected) + '">' +
          '<span class="news-menu-text"><span class="news-menu-name">' + esc(m.name || m.modelId) + "</span>" + (m.description ? '<span class="news-menu-desc">' + esc(m.description) + "</span>" : "") + "</span>" + (m.modelId === info.selected ? CHECK : "") + "</button>",
      )
      .join("");
    return '<div class="news-menu" data-model-menu role="dialog" aria-label="Models">' + (rows ? searchMarkup("models") : '<p class="news-menu-label">Model</p>') + (rows || '<p class="model-menu-empty">' + esc(empty) + "</p>") + (rows ? '<p class="model-menu-empty" data-menu-nomatch hidden>No models match.</p>' : "") + "</div>";
  }

  paintToggles() {
    const pairs = [
      ["[data-agent-picker]", this.agentToggleMarkup(), "data-agent-popup"],
      ["[data-model-picker]", this.modelToggleMarkup(), "data-model-popup"],
    ];
    for (const [sel, html, popup] of pairs) {
      const slot = this.el.querySelector(sel);
      if (!slot || slot._html === html) continue;
      slot._html = html;
      const toggle = slot.firstElementChild;
      if (!toggle || !slot.querySelector("[" + popup + "]")) {
        slot.innerHTML = html + "<div " + popup + "></div>";
        continue;
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
  }

  menus() {
    return [
      { picker: "[data-agent-picker]", toggle: "[data-agent-toggle]", popup: "[data-agent-popup]", menu: "[data-agent-menu]", markup: () => this.agentMenuMarkup() },
      { picker: "[data-model-picker]", toggle: "[data-model-toggle]", popup: "[data-model-popup]", menu: "[data-model-menu]", markup: () => this.modelMenuMarkup(), models: true },
    ];
  }

  closeMenus(except) {
    for (const m of this.menus()) {
      if (m.picker === except) continue;
      const picker = this.el.querySelector(m.picker);
      const menu = picker && picker.querySelector(m.menu);
      if (menu) menu.remove();
      const toggle = picker && picker.querySelector(m.toggle);
      if (toggle) toggle.setAttribute("aria-expanded", "false");
    }
  }

  openMenu(which) {
    const picker = this.el.querySelector(which.picker);
    if (!picker) return;
    if (picker.querySelector(which.menu)) return this.closeMenus();
    this.closeMenus(which.picker);
    if (which.models) {
      const info = this.modelInfo();
      if (!info.list.length && !info.probing) refreshModelInfo(this.currentAgentId());
    }
    const popup = picker.querySelector(which.popup);
    popup.innerHTML = which.markup();
    picker.querySelector(which.toggle).setAttribute("aria-expanded", "true");
    const menu = popup.querySelector(which.menu);
    const selected = menu.querySelector('[aria-selected="true"]');
    if (selected) selected.scrollIntoView({ block: "nearest" });
    const focus = menu.querySelector("[data-menu-search]") || selected || menu.querySelector(".news-menu-row");
    if (focus) focus.focus();
  }

  async pickAgent(id) {
    const bound = Boolean(this.snap && this.snap.transcript && this.snap.transcript.length);
    const agent = store.acpAgents.find((a) => a.id === id);
    if (!agent) return;
    if (this.snap && id !== this.snap.harnessId) {
      if (!agent.available) return toast("Install " + agent.name + " before switching this chat to it.");
      try {
        this.snap = await window.jagents.chats.handoff(this.snap.chatId, id);
        refreshChats();
        if (bound) toast(agent.name + " has this chat now, with the messages and tool calls so far.");
      } catch (error) {
        return toast(errorText(error));
      }
    } else if (!this.snap) {
      this.newAgent = id;
    }
    refreshModelInfo(id);
    this.paint();
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

  async send() {
    const text = this.input.value.trim();
    if (!text) return;
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
      this.forceScroll = true;
      this.snap = Object.assign({}, this.snap, { status: this.snap.status === "ready" ? "busy" : "starting", transcript: this.snap.transcript.concat([{ role: "user", text }]) });
      this.paint();
      const done = await window.jagents.chats.prompt(this.chatId, text);
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
      for (const which of this.menus()) {
        if (t.closest(which.toggle)) {
          event.stopPropagation();
          return this.openMenu(which);
        }
      }
      const agentPick = t.closest("[data-agent-pick]");
      if (agentPick) {
        this.closeMenus();
        return this.pickAgent(agentPick.dataset.agentPick);
      }
      if (t.closest("[data-open-market]")) {
        this.closeMenus();
        return openMarketplace();
      }
      const modelPick = t.closest("[data-model-pick]");
      if (modelPick) {
        this.closeMenus();
        return this.pickModel(modelPick.dataset.modelPick);
      }
      const auth = t.closest("[data-auth]");
      if (auth) return this.signIn(auth.dataset.auth);
      const file = t.closest("[data-open-file]");
      if (file) return window.jagents.openPath(file.dataset.openFile);
      const copyRow = t.closest("[data-copy-row]");
      if (copyRow && this.snap) {
        const row = this.snap.transcript[Number(copyRow.dataset.copyRow)];
        return row && copyText(copyRow, row.text || "");
      }
      const copyCode = t.closest("[data-copy-code]");
      if (copyCode) return copyText(copyCode, copyCode.closest(".code-block").querySelector("pre").textContent);
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
      if (search) applyFilter(search.closest(".news-menu"), search.value);
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
        const first = event.target.closest(".news-menu").querySelector("[data-menu-text]:not([hidden])");
        if (first) first.click();
        return;
      }
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      const menu = event.target.closest && event.target.closest(".news-menu");
      if (!menu) return;
      event.preventDefault();
      const rows = Array.from(menu.querySelectorAll("[data-menu-search], .news-menu-row:not([hidden])"));
      const i = rows.indexOf(document.activeElement);
      rows[(i + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length].focus();
    }, sig);
    document.addEventListener("click", (event) => {
      if (!el.contains(event.target)) this.closeMenus();
    }, sig);
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.send();
      }
    });
    this.input.addEventListener("input", () => autoGrow(this.input));
  }
}
