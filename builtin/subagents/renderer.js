// Subagents in the window (built into JAgents). Everything here is for
// looking; only a parent agent starts, messages or stops its subagents
// (through the subagents MCP server).
//
// 1. The Subagents page, in the Help tab's place (Help is hidden while this
//    plugin is on). Each parent agent is a card with a button that shows the
//    subagents it owns as small tiles.
// 2. A maximized chat whose agent has subagents puts small tiles for them in
//    the empty space beside its centered transcript: the left side first,
//    the right side only for tiles that do not fit on the left.
//
// Clicking a tile opens that subagent as a thread (the same look as a JAgents
// chat) over the page or pane, with Back to return.
//
// Redraws are idempotent (HTML is written only when it changed) and batched,
// so streaming agents do not churn the DOM.

const MODE = "subagents";
const ICON =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="5" rx="1.2"/><rect x="3" y="16" width="6" height="5" rx="1.2"/><rect x="15" y="16" width="6" height="5" rx="1.2"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/></svg>';
const ICON_SM = ICON.replace('width="15" height="15"', 'width="11" height="11"');
const TRANSCRIPT_W = 820; // JAgents' centered transcript column
const TILE_MIN = 150;
const TILE_MAX = 210;
const TILE_H = 52; // a tile's height before one is drawn
const TILE_GAP = 8;
const GUTTER_SPARE = 216; // top offset plus the composer below the gutters

const STATE = {
  busy: ["Working", "busy"],
  starting: ["Starting", "busy"],
  ready: ["Idle", "ok"],
  idle: ["Idle", "ok"],
  error: ["Error", "danger"],
  stopped: ["Stopped", "off"],
};
const stateOf = (s) => STATE[s] || [s || "Unknown", "off"];
const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
const short = (h) => String(h).split("/").pop();

// Effort levels as people read them. Agents send ids like xhigh or
// "Thinking: max"; these read the same for every provider.
const EFFORT_LABEL = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", default: "Default", off: "Off" };
function effortLabel(value, name) {
  if (!value) return "Default";
  if (EFFORT_LABEL[value]) return EFFORT_LABEL[value];
  const n = String(name || value).replace(/^(thinking|effort|reasoning)\s*:\s*/i, "");
  return n.charAt(0).toUpperCase() + n.slice(1);
}

// Older Cursor model ids carry their settings in brackets:
// grok-4.7[context=256k,reasoning_effort=high,fast=true]. Show the model name.
function modelLabel(id, name) {
  const m = /^([^[\]]+)\[([^\]]*)\]$/.exec(String(id || ""));
  if (!m) return name && name !== id ? name : String(id || "");
  return name && name !== id ? name : m[1];
}

// Which company a model comes from, for grouping the model picker.
function vendorOf(id) {
  const s = String(id).toLowerCase();
  if (s.includes("/")) {
    const p = s.split("/")[0];
    return p.charAt(0).toUpperCase() + p.slice(1);
  }
  const rules = [
    [/^(default|auto)\b/, "Auto"],
    [/claude|opus|sonnet|haiku|fable/, "Anthropic"],
    [/^gpt|^o\d|codex|openai/, "OpenAI"],
    [/gemini|gemma/, "Google"],
    [/grok/, "xAI"],
    [/kimi|moonshot/, "Moonshot"],
    [/glm|zhipu/, "Zhipu"],
    [/composer|cursor/, "Cursor"],
    [/deepseek/, "DeepSeek"],
    [/qwen/, "Qwen"],
    [/llama|muse/, "Meta"],
    [/mistral|codestral|devstral/, "Mistral"],
    [/swe-|devin/, "Cognition"],
    [/nemotron|nvidia/, "NVIDIA"],
    [/minimax/, "MiniMax"],
  ];
  for (const [re, v] of rules) if (re.test(s)) return v;
  return "Other";
}

const GAUGE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 17a8 8 0 1 1 15 0"/><path d="M12 13.5l3.6-4"/><circle cx="12" cy="14" r="1.2" fill="currentColor"/></svg>';

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}

function setHtml(el, html) {
  if (el._subHtml !== html) {
    el._subHtml = html;
    el.innerHTML = html;
  }
}

export async function activate(jagents) {
  const esc = jagents.esc;
  const seg = document.querySelector(".mode-seg");
  const sidebar = document.querySelector(".sidebar");
  const mainArea = document.querySelector("main.main");
  if (!seg || !sidebar || !mainArea) return;

  // JAgents' own markdown and agent icons, so threads look like its chats.
  let markdown = (t) => esc(t).replace(/\n/g, "<br>");
  let harnessIcon = () => "";
  try {
    const util = await import(new URL("../../js/util.js", import.meta.url).href);
    if (util.markdown) markdown = util.markdown;
  } catch {
    /* plain text */
  }
  try {
    const icons = await import(new URL("../../js/icons.js", import.meta.url).href);
    if (icons.harnessIcon) harnessIcon = icons.harnessIcon;
  } catch {
    /* no icons */
  }

  let alive = true;
  let agents = [];
  let subs = [];
  const open = new Set(jagents.storage.get("openParents", []) || []);
  const transcripts = new Map(); // handle -> data
  let pageThread = ""; // subagent open as a thread on the page
  let pageTab = jagents.storage.get("pageTab", "list") === "defaults" ? "defaults" : "list";
  let control = null; // providers with models, effort levels and defaults

  // ---- Tab (in Help's place), sidebar, page ----

  const helpTab = seg.querySelector('[data-mode="help"]');
  const tab = document.createElement("button");
  tab.setAttribute("role", "tab");
  tab.dataset.mode = MODE;
  tab.title = "Agents and the subagents they own";
  tab.innerHTML = ICON + "Subagents";
  seg.insertBefore(tab, helpTab || null);
  const helpWasOn = Boolean(helpTab && helpTab.classList.contains("on"));
  if (helpTab) helpTab.hidden = true;

  const side = document.createElement("div");
  side.className = "side-pane sub-side";
  side.hidden = true;
  side.innerHTML =
    '<p class="nav-label">Parents</p><div class="sub-side-list" data-sub-side></div>' +
    '<p class="nav-label">MCP servers subagents get</p><div class="sub-servers" data-sub-servers><p class="nav-empty">Loading…</p></div>';
  sidebar.insertBefore(side, sidebar.querySelector(".sidebar-updates"));

  const view = document.createElement("div");
  view.className = "sub-mode sub-page";
  view.hidden = true;
  view.innerHTML =
    '<div class="sub-list" data-sub-list><div class="sub-head"><div><h1>Subagents</h1><p class="muted small" data-sub-summary></p></div><span class="spacer"></span>' +
    '<div class="seg sub-tabs" role="tablist" aria-label="Subagents views"><button type="button" role="tab" data-sub-tab="list">Subagents</button><button type="button" role="tab" data-sub-tab="defaults">Settings</button></div></div>' +
    '<div class="sub-body" data-sub-body><p class="sub-empty">Loading…</p></div>' +
    '<div class="sub-body sub-defaults" data-sub-defaults hidden></div></div>' +
    '<div class="sub-thread-host" data-sub-page-thread hidden></div>';
  mainArea.appendChild(view);

  const byParent = () => {
    const map = new Map();
    for (const s of subs) {
      if (!map.has(s.parent)) map.set(s.parent, []);
      map.get(s.parent).push(s);
    }
    return map;
  };

  // ---- Tiles and threads ----

  // Working gets a spinner and an error an icon; idle and stopped are plain text.
  const stateMark = (tone) => (tone === "busy" ? '<span class="spinner sm" aria-hidden="true"></span>' : tone === "danger" ? jagents.icon("alert", 13) : "");

  function tile(s, attr) {
    const [label, tone] = stateOf(s.status);
    return (
      '<button type="button" class="sub-tile" ' + attr + '="' + esc(s.handle) + '" title="Open ' + esc(s.handle) + " · " + esc(s.task) + '">' +
      '<span class="sub-tile-ic">' + harnessIcon(s.provider, 16) + "</span>" +
      '<span class="sub-tile-txt"><b>' + esc(short(s.handle)) + "</b><span>" + esc([s.providerName, s.model && modelLabel(s.model), s.effort && effortLabel(s.effort)].filter(Boolean).join(" · ")) + "</span></span>" +
      '<span class="sub-tile-state ' + tone + '">' + stateMark(tone) + esc(label) + "</span></button>"
    );
  }

  function rowHtml(r, parent) {
    if (r.role === "user") return '<div class="msg user relayed"><span class="from-tag">' + esc(parent) + '</span><div class="bubble">' + esc(r.text) + "</div></div>";
    if (r.role === "assistant") return '<div class="msg agent"><div class="bubble">' + markdown(r.text) + "</div></div>";
    if (r.role === "thought") return '<details class="thought"><summary>Thinking</summary><div>' + esc(r.text) + "</div></details>";
    if (r.role === "tool") return '<div class="tool ' + esc(r.status || "pending") + '"><span class="sub-tool-mark">' + (r.status === "completed" ? jagents.icon("check", 13) : r.status === "failed" ? jagents.icon("alert", 13) : '<span class="spinner sm"></span>') + '</span><span class="grow">' + esc(r.text) + "</span></div>";
    if (r.role === "error") return '<div class="err-row">' + esc(r.text) + "</div>";
    return '<div class="sys">' + esc(r.text) + "</div>";
  }

  function threadHtml(s, t) {
    const [label, tone] = stateOf(s.status);
    const rows = t && t.rows ? t.rows.slice(-200) : null;
    return (
      '<header class="sub-thread-head">' +
      '<button type="button" class="btn sm ghost" data-sub-back title="Back">' + jagents.icon("back", 15) + "<span>Back</span></button>" +
      '<span class="pane-ic">' + harnessIcon(s.provider, 15) + "</span>" +
      '<span class="pane-handle">' + esc(s.handle) + "</span>" +
      '<span class="chip sub-chip">' + ICON_SM + "Subagent of " + esc(s.parent) + "</span>" +
      (s.model ? '<span class="chip" title="' + esc(s.model) + '">' + esc(modelLabel(s.model)) + "</span>" : "") +
      (s.effort ? '<span class="chip">' + GAUGE + "Effort " + esc(effortLabel(s.effort)) + "</span>" : "") +
      '<span class="sub-tile-state ' + tone + '">' + stateMark(tone) + esc(label) + "</span>" +
      "</header>" +
      '<div class="transcript" data-sub-scroll><div class="transcript-inner">' +
      (rows ? (rows.length ? rows.map((r) => rowHtml(r, s.parent)).join("") : '<div class="sys">Nothing yet.</div>') : '<div class="sys">Loading…</div>') +
      "</div></div>" +
      '<footer class="sub-thread-foot">' + ICON_SM + "Only " + esc(s.parent) + " can message or stop this subagent. Ask " + esc(s.parent) + " if you want something from it.</footer>"
    );
  }

  // Keep the thread pinned to the bottom unless the user scrolled up.
  function paintThread(host, s) {
    const box = host.querySelector("[data-sub-scroll]");
    const pinned = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    setHtml(host, threadHtml(s, transcripts.get(s.handle)));
    const nbox = host.querySelector("[data-sub-scroll]");
    if (nbox && pinned) nbox.scrollTop = nbox.scrollHeight;
  }

  async function loadTranscript(handle) {
    try {
      transcripts.set(handle, await jagents.invoke("transcript", { handle }));
    } catch {
      transcripts.delete(handle);
    }
  }

  // ---- The page ----

  // ---- Settings: on/off, and model and effort per provider ----

  const provList = () => (control && control.providers) || [];
  const findProv = (id) => provList().find((p) => p.provider === id);

  function switchHtml(on, attr, label) {
    return '<button type="button" role="switch" class="sub-switch" ' + attr + ' aria-checked="' + on + '" aria-label="' + esc(label) + '" title="' + esc(label + (on ? ": on" : ": off")) + '"><span class="sub-switch-knob"></span></button>';
  }

  // The model a provider uses for new subagents: the user's pick, else the agent's own.
  function chosenModel(p) {
    const c = p.catalog || {};
    return (p.defaults && p.defaults.model) || c.defaultModel || "";
  }

  // Effort levels for a provider with a model: per model (Claude Code,
  // Cursor), else one list for the provider.
  function effortsFor(p, modelId) {
    const c = p.catalog;
    if (!c) return [];
    const names = new Map((c.efforts || []).map((e) => [e.value, e.name]));
    const models = c.models || [];
    const perModel = models.some((m) => Array.isArray(m.efforts) && m.efforts.length);
    let values = (c.efforts || []).map((e) => e.value);
    if (perModel) {
      const m = models.find((x) => x.id === modelId);
      values = m && Array.isArray(m.efforts) ? m.efforts : [];
    }
    return values.filter((v) => v !== "default").map((v) => ({ value: v, label: effortLabel(v, names.get(v)) }));
  }

  function modelButton(p) {
    const c = p.catalog;
    const models = (c && c.models) || [];
    const d = p.defaults || {};
    if (!models.length) return '<span class="muted small sub-field-note">' + (c ? (c.error ? "Not available" : "This agent has no model choice") : "Detect to load its models") + "</span>";
    const pick = models.find((m) => m.id === d.model);
    const agentDef = models.find((m) => m.id === c.defaultModel);
    const name = d.model ? modelLabel(d.model, pick && pick.name) : "Agent default";
    const sub = d.model ? (pick ? (pick.name && pick.name !== pick.id ? pick.id : vendorOf(pick.id)) : "Not offered now") : agentDef ? modelLabel(agentDef.id, agentDef.name) : "";
    return (
      '<button type="button" class="sub-mpick' + (d.model && !pick ? " stale" : "") + '" data-sub-mpick="' + esc(p.provider) + '" aria-haspopup="listbox" aria-label="Default model for ' + esc(p.name) + ": " + esc(name) + '">' +
      '<span class="sub-mpick-txt"><span class="sub-mpick-name">' + esc(name) + "</span>" + (sub ? '<span class="sub-mpick-sub">' + esc(sub) + "</span>" : "") + "</span>" +
      jagents.icon("chevronDown", 12) + "</button>"
    );
  }

  function effortSeg(p) {
    const c = p.catalog;
    const d = p.defaults || {};
    const list = effortsFor(p, chosenModel(p));
    if (!list.length) {
      const why = !c ? "Detect to load its effort levels" : c.error ? "Not available" : (c.models || []).some((m) => Array.isArray(m.efforts)) ? "This model has no effort setting" : "This agent has no effort setting";
      return '<span class="muted small sub-field-note">' + esc(why) + "</span>";
    }
    const btn = (value, label, extra, title) => {
      const on = (d.effort || "") === value;
      return (
        '<button type="button" role="radio" class="sub-seg-btn' + (extra || "") + (on ? " on" : "") + '" aria-checked="' + on + '" data-sub-eff="' + esc(p.provider) + '" data-value="' + esc(value) + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" + esc(label) + "</button>"
      );
    };
    const agentDef = c.defaultEffort ? effortLabel(c.defaultEffort, ((c.efforts || []).find((e) => e.value === c.defaultEffort) || {}).name) : "";
    return (
      '<div class="sub-seg" role="radiogroup" aria-label="Default effort for ' + esc(p.name) + '">' +
      btn("", "Default", "", "The agent's own" + (agentDef ? " (" + agentDef + ")" : "")) +
      list.map((e) => btn(e.value, e.label)).join("") +
      (d.effort && !list.some((e) => e.value === d.effort) ? btn(d.effort, effortLabel(d.effort) + " (not offered)", " stale") : "") +
      "</div>"
    );
  }

  function providerCard(p) {
    const c = p.catalog || null;
    const state = p.detecting ? "Detecting…" : c ? (c.error ? c.error : "Detected " + ago(c.at)) : "Not detected yet";
    const models = (c && c.models) || [];
    return (
      '<article class="sub-pcard' + (p.enabled ? "" : " off") + '" data-sub-pcard="' + esc(p.provider) + '">' +
      '<header><span class="pane-ic">' + harnessIcon(p.provider, 18) + '</span><div class="grow"><b>' + esc(p.name) + '</b><span class="muted small mono">' + esc(p.provider) + "</span></div>" +
      '<span class="muted small sub-det' + (c && c.error ? " sub-bad" : "") + '" title="' + esc(state) + '">' + (p.detecting ? '<span class="spinner sm"></span>' : "") + esc(state) + (c && !c.error && models.length ? " · " + models.length + (models.length === 1 ? " model" : " models") : "") + "</span>" +
      '<button type="button" class="btn sm ghost" data-sub-detect="' + esc(p.provider) + '"' + (p.detecting ? " disabled" : "") + ' title="Start ' + esc(p.name) + ' once, with no tools, to read its models and effort levels">' + jagents.icon("restart", 13) + "<span>" + (c ? "Detect again" : "Detect") + "</span></button>" +
      switchHtml(p.enabled, 'data-sub-prov-on="' + esc(p.provider) + '"', p.name + " subagents") +
      "</header>" +
      (p.enabled
        ? '<div class="sub-pcard-body"><div class="sub-field"><span class="sub-field-label">Model</span>' + modelButton(p) + '</div><div class="sub-field"><span class="sub-field-label">Effort</span>' + effortSeg(p) + "</div></div>"
        : '<p class="muted small sub-pcard-off">Off. Agents cannot start ' + esc(p.name) + " subagents.</p>") +
      "</article>"
    );
  }

  function defaultsHtml() {
    if (!control) return '<p class="sub-empty">Loading providers…</p>';
    const installed = provList().filter((p) => p.installed);
    const missing = provList().filter((p) => !p.installed);
    return (
      '<section class="sub-power' + (control.on ? "" : " off") + '"><div class="grow"><b>' + (control.on ? "Subagents are on" : "Subagents are off") + "</b>" +
      '<p class="muted small">' + (control.on
        ? "Agents can start subagents with the subagents MCP server, using the model and effort below unless they pick others."
        : "Agents cannot start or message subagents. A turn already running finishes; existing subagents stay listed.") + "</p></div>" +
      switchHtml(control.on, "data-sub-power", "Subagents") + "</section>" +
      '<div class="sub-def-head"><h2>Providers</h2><p class="muted small">Model and effort for new subagents. Detect starts an agent once, with no tools, to read what it offers.</p>' +
      '<button type="button" class="btn sm secondary" data-sub-detect-all' + (provList().some((p) => p.detecting) ? " disabled" : "") + ">" + jagents.icon("restart", 14) + "<span>Detect all</span></button></div>" +
      '<div class="sub-pcards' + (control.on ? "" : " dim") + '">' + installed.map(providerCard).join("") + "</div>" +
      (missing.length ? '<p class="muted small sub-missing">Not installed: ' + missing.map((p) => esc(p.name) + (p.install ? ' <span class="mono">(' + esc(p.install) + ")</span>" : "")).join(", ") + "</p>" : "")
    );
  }

  async function loadControl() {
    try {
      control = await jagents.invoke("control");
    } catch (e) {
      control = null;
      setHtml(view.querySelector("[data-sub-defaults]"), '<p class="sub-empty">' + esc(errText(e)) + "</p>");
      return;
    }
    paintPage();
  }

  async function setDefault(provider, patch, what) {
    try {
      control = await jagents.invoke("set-default", Object.assign({ provider }, patch));
      const p = findProv(provider);
      jagents.toast((p ? p.name : provider) + ": " + what + " for new subagents");
    } catch (err) {
      jagents.toast(errText(err));
    }
    paintPage();
  }

  let detectingAll = false;
  async function detectAll() {
    if (detectingAll) return;
    detectingAll = true;
    const list = provList().filter((p) => p.installed && p.enabled);
    // Two at a time: each one starts a real agent process.
    let i = 0;
    const worker = async () => {
      while (i < list.length && alive) {
        const p = list[i++];
        try {
          control = await jagents.invoke("detect", { provider: p.provider });
        } catch {
          /* shown on its card */
        }
        if (alive) paintPage();
      }
    };
    await Promise.all([worker(), worker()]);
    detectingAll = false;
    if (alive) jagents.toast("Detected models and effort for " + list.length + " providers");
  }

  // ---- Popovers: the model picker and effort menus ----
  //
  // One at a time, fixed to the window (so page redraws never close it), on
  // document.body (so it shows over chats too). Arrow keys move, Enter picks,
  // Escape closes.

  let pop = null; // {el, anchor, onPick}

  function closePop(refocus) {
    if (!pop) return;
    const { el, anchor } = pop;
    pop = null;
    el.remove();
    if (anchor && anchor.isConnected) {
      anchor.setAttribute("aria-expanded", "false");
      if (refocus) anchor.focus();
    }
  }

  function placePop(el, anchor, width) {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(width, window.innerWidth - 16);
    el.style.width = w + "px";
    el.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px";
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const h = Math.min(el.scrollHeight, 420);
    if (below >= Math.min(h, 260) || below >= above) {
      el.style.top = r.bottom + 6 + "px";
      el.style.maxHeight = Math.max(160, below) + "px";
    } else {
      el.style.top = Math.max(8, r.top - 6 - Math.min(h, above)) + "px";
      el.style.maxHeight = above + "px";
    }
  }

  function openPop(anchor, html, width, onPick) {
    closePop();
    const el = document.createElement("div");
    el.className = "sub-pop";
    el.innerHTML = html;
    document.body.appendChild(el);
    pop = { el, anchor, onPick };
    anchor.setAttribute("aria-expanded", "true");
    placePop(el, anchor, width);
    const sel = el.querySelector(".sub-pop-row.sel") || el.querySelector(".sub-pop-row");
    if (sel) {
      sel.classList.add("active");
      sel.scrollIntoView({ block: "nearest" });
    }
    const search = el.querySelector("[data-sub-search]");
    (search || sel || el).focus();
    el.addEventListener("click", (e) => {
      const row = e.target.closest(".sub-pop-row");
      if (row && pop && pop.el === el) {
        const fn = pop.onPick;
        closePop(true);
        fn(row.dataset.value);
      }
    });
    el.addEventListener("input", (e) => {
      if (e.target.matches("[data-sub-search]")) filterPop(e.target.value);
    });
    el.addEventListener("keydown", onPopKey);
  }

  function visibleRows() {
    return pop ? [...pop.el.querySelectorAll(".sub-pop-row")].filter((r) => !r.hidden) : [];
  }

  function filterPop(text) {
    const terms = String(text).toLowerCase().split(/\s+/).filter(Boolean);
    for (const r of pop.el.querySelectorAll(".sub-pop-row")) {
      const show = terms.every((t) => r.dataset.text.includes(t));
      if (r.hidden === show) r.hidden = !show;
    }
    for (const g of pop.el.querySelectorAll(".sub-pop-group")) {
      const show = Boolean(g.querySelector(".sub-pop-row:not([hidden])"));
      if (g.hidden === show) g.hidden = !show;
    }
    const none = pop.el.querySelector("[data-sub-nomatch]");
    if (none) none.hidden = visibleRows().length > 0;
    const act = pop.el.querySelector(".sub-pop-row.active");
    if (!act || act.hidden) {
      if (act) act.classList.remove("active");
      const first = visibleRows()[0];
      if (first) first.classList.add("active");
    }
  }

  function onPopKey(e) {
    if (!pop) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return closePop(true);
    }
    const rows = visibleRows();
    const cur = rows.findIndex((r) => r.classList.contains("active"));
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return;
      const next = rows[e.key === "ArrowDown" ? Math.min(rows.length - 1, cur + 1) : Math.max(0, cur - 1)];
      for (const r of rows) if (r !== next && r.classList.contains("active")) r.classList.remove("active");
      next.classList.add("active");
      next.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const r = rows[cur] || rows[0];
      if (!r) return;
      e.preventDefault();
      const fn = pop.onPick;
      closePop(true);
      fn(r.dataset.value);
    }
  }

  const onDocDown = (e) => {
    if (pop && !pop.el.contains(e.target) && !pop.anchor.contains(e.target)) closePop();
  };
  const onDocScroll = (e) => {
    if (pop && !pop.el.contains(e.target)) closePop();
  };
  document.addEventListener("mousedown", onDocDown, true);
  document.addEventListener("scroll", onDocScroll, true);

  function popRow(value, name, sub, selected, extra) {
    return (
      '<button type="button" role="option" class="sub-pop-row' + (selected ? " sel" : "") + '" data-value="' + esc(value) + '" data-text="' + esc((name + " " + value + " " + (extra || "")).toLowerCase()) + '" aria-selected="' + selected + '">' +
      '<span class="sub-pop-txt"><span class="sub-pop-name">' + esc(name) + "</span>" + (sub ? '<span class="sub-pop-sub">' + esc(sub) + "</span>" : "") + "</span>" +
      (selected ? '<span class="sub-pop-check">' + jagents.icon("check", 14) + "</span>" : "") + "</button>"
    );
  }

  function openModelPicker(anchor, provider) {
    const p = findProv(provider);
    if (!p || !p.catalog) return;
    const c = p.catalog;
    const d = p.defaults || {};
    const byVendor = new Map();
    for (const m of c.models || []) {
      const v = vendorOf(m.id);
      if (!byVendor.has(v)) byVendor.set(v, []);
      byVendor.get(v).push(m);
    }
    // Auto first, Other last, the rest in the agent's own order.
    const rank = (v) => (v === "Auto" ? 0 : v === "Other" ? 2 : 1);
    const groups = [...byVendor].sort((a, b) => rank(a[0]) - rank(b[0]));
    const effNames = new Map((c.efforts || []).map((e) => [e.value, e.name]));
    const rowFor = (m) => {
      const name = modelLabel(m.id, m.name);
      const levels = Array.isArray(m.efforts) && m.efforts.length ? m.efforts.map((v) => effortLabel(v, effNames.get(v))) : [];
      const sub = [name !== m.id ? m.id : "", levels.length ? "Effort " + levels.join(", ") : "", m.id === c.defaultModel ? "agent default" : ""].filter(Boolean).join(" · ");
      return popRow(m.id, name, sub, m.id === d.model, vendorOf(m.id));
    };
    const agentDef = (c.models || []).find((m) => m.id === c.defaultModel);
    const html =
      '<div class="sub-pop-search">' + jagents.icon("search", 14) + '<input type="text" data-sub-search placeholder="Search ' + (c.models || []).length + ' models" aria-label="Search models" spellcheck="false" autocomplete="off"></div>' +
      '<div class="sub-pop-list" role="listbox" aria-label="Models for ' + esc(p.name) + '">' +
      '<div class="sub-pop-group">' + popRow("", "Agent default", agentDef ? modelLabel(agentDef.id, agentDef.name) : "Whatever " + p.name + " picks", !d.model, "default") + "</div>" +
      [...groups]
        .map(([v, list]) => '<div class="sub-pop-group" role="group" aria-label="' + esc(v) + '"><p class="sub-pop-label">' + esc(v) + "</p>" + list.map(rowFor).join("") + "</div>")
        .join("") +
      '<p class="sub-pop-none" data-sub-nomatch hidden>No models match.</p></div>';
    openPop(anchor, html, 380, (value) => {
      const m = (c.models || []).find((x) => x.id === value);
      setDefault(provider, { model: value }, "model " + (value ? modelLabel(value, m && m.name) : "agent default"));
    });
  }

  view.addEventListener("click", (e) => {
    const mp = e.target.closest("[data-sub-mpick]");
    if (mp) {
      if (pop && pop.anchor === mp) return closePop();
      return openModelPicker(mp, mp.dataset.subMpick);
    }
    const eb = e.target.closest("[data-sub-eff]");
    if (eb) {
      const p = findProv(eb.dataset.subEff);
      if (p && (p.defaults.effort || "") === eb.dataset.value) return;
      return setDefault(eb.dataset.subEff, { effort: eb.dataset.value }, "effort " + effortLabel(eb.dataset.value));
    }
    const po = e.target.closest("[data-sub-prov-on]");
    if (po) {
      const on = po.getAttribute("aria-checked") !== "true";
      const id = po.dataset.subProvOn;
      jagents.invoke("set-provider-enabled", { provider: id, enabled: on }).then(
        (c) => {
          control = c;
          const p = findProv(id);
          jagents.toast((p ? p.name : id) + " subagents " + (on ? "on" : "off"));
          paintPage();
        },
        (err) => jagents.toast(errText(err)),
      );
      return;
    }
    const pw = e.target.closest("[data-sub-power]");
    if (pw) {
      const on = pw.getAttribute("aria-checked") !== "true";
      jagents.invoke("set-enabled", { enabled: on }).then(
        (c) => {
          control = c;
          jagents.toast(on ? "Subagents on" : "Subagents off. Agents cannot start or message subagents.");
          paintPage();
        },
        (err) => jagents.toast(errText(err)),
      );
    }
  });

  function paintPage() {
    for (const b of view.querySelectorAll("[data-sub-tab]")) {
      const on = b.dataset.subTab === pageTab;
      if (b.classList.contains("on") !== on) b.classList.toggle("on", on);
      if (b.getAttribute("aria-selected") !== String(on)) b.setAttribute("aria-selected", String(on));
    }
    const listBody = view.querySelector("[data-sub-body]");
    const defBody = view.querySelector("[data-sub-defaults]");
    if (listBody.hidden !== (pageTab !== "list")) listBody.hidden = pageTab !== "list";
    if (defBody.hidden !== (pageTab !== "defaults")) defBody.hidden = pageTab !== "defaults";
    if (pageTab === "defaults") setHtml(defBody, defaultsHtml());
    const host = view.querySelector("[data-sub-page-thread]");
    const list = view.querySelector("[data-sub-list]");
    const s = subs.find((x) => x.handle === pageThread);
    if (s) {
      if (host.hidden) host.hidden = false;
      if (!list.hidden) list.hidden = true;
      paintThread(host, s);
    } else {
      pageThread = "";
      if (!host.hidden) host.hidden = true;
      if (list.hidden) list.hidden = false;
    }

    const groups = byParent();
    const live = new Map(agents.map((a) => [a.handle, a]));
    const parents = [...groups.keys()].sort((a, b) => Number(live.has(b)) - Number(live.has(a)) || a.localeCompare(b));
    const working = subs.filter((x) => x.status === "busy" || x.status === "starting").length;
    const summary = parents.length + (parents.length === 1 ? " parent · " : " parents · ") + subs.length + " subagents · " + working + " working" + (control && !control.on ? " · turned off" : "");
    const sum = view.querySelector("[data-sub-summary]");
    if (sum.textContent !== summary) sum.textContent = summary;
    const others = agents.filter((a) => !groups.has(a.handle)).length;

    const cards = parents.map((p) => {
      const kids = groups.get(p);
      const a = live.get(p);
      const isOpen = open.has(p);
      const busyN = kids.filter((x) => x.status === "busy" || x.status === "starting").length;
      return (
        '<article class="sub-parent" data-sub-parent="' + esc(p) + '">' +
        '<header><span class="pane-ic">' + (a ? harnessIcon(a.provider, 16) : "") + '</span><div class="grow"><b>' + esc(p) + "</b>" +
        (a ? "" : ' <span class="chip">closed</span>') +
        '<div class="muted small sub-ptitle">' + esc(a ? a.title || "" : "This agent is no longer running.") + "</div></div>" +
        '<button type="button" class="btn sm ' + (isOpen ? "secondary" : "primary") + '" data-sub-toggle="' + esc(p) + '" aria-expanded="' + isOpen + '">' +
        ICON_SM + (isOpen ? "Hide subagents" : kids.length + (kids.length === 1 ? " subagent" : " subagents")) + (busyN && !isOpen ? " · " + busyN + " working" : "") + "</button></header>" +
        (isOpen ? '<div class="sub-kids">' + kids.map((x) => tile(x, "data-sub-open")).join("") + "</div>" : "") +
        "</article>"
      );
    });
    setHtml(
      view.querySelector("[data-sub-body]"),
      (control && !control.on ? '<p class="sub-banner">' + ICON_SM + 'Subagents are off. Agents cannot start or message them. <button type="button" class="btn sm secondary" data-sub-tab="defaults">Open Settings</button></p>' : "") +
        (cards.length ? cards.join("") : '<p class="sub-empty">No agent has subagents yet. Agents start them with the subagents MCP server (subagents.spawn).</p>') +
        (others ? '<p class="muted small sub-others">' + others + (others === 1 ? " other agent has" : " other agents have") + " no subagents.</p>" : ""),
    );

    setHtml(
      side.querySelector("[data-sub-side]"),
      parents
        .map((p) => {
          const kids = groups.get(p);
          const tone = kids.some((x) => x.status === "busy" || x.status === "starting") ? "busy" : live.has(p) ? "ok" : "off";
          return '<button type="button" class="sub-side-item' + (tone === "off" ? " off" : "") + '" data-sub-goto="' + esc(p) + '"' + (tone === "off" ? ' title="' + esc(p) + ' is closed"' : "") + '><span class="grow">' + esc(p) + "</span>" + (tone === "busy" ? '<span class="spinner sm" role="img" aria-label="Working"></span>' : "") + '<span class="sub-side-n">' + kids.length + "</span></button>";
        })
        .join("") || '<p class="nav-empty">No parents yet.</p>',
    );
  }

  async function paintServers() {
    const box = side.querySelector("[data-sub-servers]");
    let list;
    try {
      list = await jagents.invoke("servers");
    } catch (e) {
      return setHtml(box, '<p class="nav-empty">' + esc(errText(e)) + "</p>");
    }
    setHtml(
      box,
      (list.length
        ? list.map((s) => '<label class="sub-server"><input type="checkbox" data-sub-server="' + esc(s.name) + '"' + (s.allowed ? " checked" : "") + '><span class="grow">' + esc(s.name) + '</span><span class="muted small">' + esc(s.plugin) + "</span></label>").join("")
        : '<p class="nav-empty">No plugin MCP servers.</p>') +
        '<p class="sub-note muted small">Never: jagents, subagents. Subagents cannot start agents.</p>',
    );
  }

  side.addEventListener("change", async (e) => {
    if (!e.target.matches("[data-sub-server]")) return;
    const allowed = [...side.querySelectorAll("[data-sub-server]:checked")].map((x) => x.dataset.subServer);
    try {
      await jagents.invoke("set-servers", { allowed });
      jagents.toast("Subagents started from now on get: " + (allowed.join(", ") || "no MCP servers"));
    } catch (err) {
      jagents.toast(errText(err));
    }
    paintServers();
  });

  function onPageClick(e) {
    const tb = e.target.closest("[data-sub-tab]");
    if (tb) {
      pageTab = tb.dataset.subTab;
      jagents.storage.set("pageTab", pageTab);
      if (pageTab === "defaults") loadControl();
      return paintPage();
    }
    const dt = e.target.closest("[data-sub-detect]");
    if (dt) {
      dt.disabled = true;
      jagents.invoke("detect", { provider: dt.dataset.subDetect }).then(
        (c) => {
          control = c;
          if (alive) paintPage();
        },
        (err) => jagents.toast(errText(err)),
      );
      setTimeout(loadControl, 300);
      return;
    }
    if (e.target.closest("[data-sub-detect-all]")) {
      detectAll();
      setTimeout(loadControl, 300);
      return;
    }
    const t = e.target.closest("[data-sub-toggle]");
    if (t) {
      const p = t.dataset.subToggle;
      if (open.has(p)) open.delete(p);
      else open.add(p);
      jagents.storage.set("openParents", [...open]);
      return paintPage();
    }
    const o = e.target.closest("[data-sub-open]");
    if (o) {
      pageThread = o.dataset.subOpen;
      loadTranscript(pageThread).then(() => alive && paintPage());
      return paintPage();
    }
    if (e.target.closest("[data-sub-back]")) {
      pageThread = "";
      return paintPage();
    }
    const g = e.target.closest("[data-sub-goto]");
    if (g) {
      pageThread = "";
      open.add(g.dataset.subGoto);
      jagents.storage.set("openParents", [...open]);
      paintPage();
      const card = view.querySelector('[data-sub-parent="' + CSS.escape(g.dataset.subGoto) + '"]');
      if (card) card.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }
  view.addEventListener("click", onPageClick);
  side.addEventListener("click", onPageClick);

  // ---- Maximized chat panes: tiles in the empty sides ----

  // pane element -> {left, right, thread, parent, openSub}
  const gutters = new Map();

  function maxChatPane() {
    const el = document.querySelector(".grid-row .pane.chat.is-max");
    if (!el || el.closest("[hidden]")) return null;
    const pane = ((jagents.store && jagents.store.panes) || []).find((p) => p.id === el.dataset.pane);
    return pane && pane.handle ? { el, handle: pane.handle } : null;
  }

  function removeGutter(el) {
    const g = gutters.get(el);
    if (!g) return;
    g.left.remove();
    g.right.remove();
    g.thread.remove();
    gutters.delete(el);
  }

  function paintGutters() {
    if (!alive) return;
    const hit = maxChatPane();
    for (const el of [...gutters.keys()]) if (!hit || hit.el !== el) removeGutter(el);
    if (!hit) return;
    const kids = subs.filter((s) => s.parent === hit.handle);
    const body = hit.el.querySelector(".pane-body");
    if (!body || !kids.length) return removeGutter(hit.el);
    const space = Math.floor((body.clientWidth - TRANSCRIPT_W) / 2) - 28;
    let g = gutters.get(hit.el);
    if (!g) {
      const mk = (cls) => {
        const d = document.createElement("div");
        d.className = cls;
        body.appendChild(d);
        return d;
      };
      g = { left: mk("sub-gutter sub-gutter-left"), right: mk("sub-gutter sub-gutter-right"), thread: mk("sub-thread-host sub-pane-thread"), parent: hit.handle, openSub: "" };
      g.thread.hidden = true;
      const onClick = (e) => {
        const o = e.target.closest("[data-sub-gopen]");
        if (o) {
          g.openSub = o.dataset.subGopen;
          loadTranscript(g.openSub).then(paintGutters);
          return paintGutters();
        }
        if (e.target.closest("[data-sub-back]")) {
          g.openSub = "";
          paintGutters();
        }
      };
      g.left.addEventListener("click", onClick);
      g.right.addEventListener("click", onClick);
      g.thread.addEventListener("click", onClick);
      gutters.set(hit.el, g);
    }

    // The open subagent thread covers the pane; Back returns to the parent.
    const opened = kids.find((s) => s.handle === g.openSub);
    if (!opened) g.openSub = "";
    if (g.thread.hidden === Boolean(opened)) g.thread.hidden = !opened;
    if (opened) paintThread(g.thread, opened);

    // Tiles fill the left side first; only the ones that do not fit there go
    // to the right side.
    const fits = space >= TILE_MIN && !opened;
    const w = Math.min(space, TILE_MAX) + "px";
    const first = g.left.querySelector(".sub-tile");
    const tileH = (first && first.offsetHeight) || TILE_H;
    const room = body.clientHeight - GUTTER_SPARE;
    const perSide = Math.max(1, Math.floor((room + TILE_GAP) / (tileH + TILE_GAP)));
    for (const [box, list] of [[g.left, kids.slice(0, perSide)], [g.right, kids.slice(perSide)]]) {
      const show = fits && list.length > 0;
      if (box.hidden === show) box.hidden = !show;
      if (!show) continue;
      if (box.style.width !== w) box.style.width = w;
      setHtml(box, list.map((s) => tile(s, "data-sub-gopen")).join(""));
    }
  }

  // ---- Refresh, batched ----

  let timer = 0;
  let loading = false;
  let again = false;
  const wanted = () => !view.hidden || Boolean(maxChatPane()) || gutters.size > 0;

  async function refresh() {
    if (!alive || !wanted()) return;
    if (loading) {
      again = true;
      return;
    }
    loading = true;
    try {
      const st = await jagents.invoke("state");
      agents = st.agents || [];
      subs = st.subagents || [];
      const shown = new Set([pageThread, ...[...gutters.values()].map((g) => g.openSub)].filter(Boolean));
      await Promise.all([...shown].map((h) => loadTranscript(h)));
      if (!alive) return;
      if (!view.hidden) control = await jagents.invoke("control");
      if (!view.hidden) paintPage();
      paintGutters();
    } catch (e) {
      if (!view.hidden) setHtml(view.querySelector("[data-sub-body]"), '<p class="sub-empty">Could not load subagents: ' + esc(errText(e)) + "</p>");
    } finally {
      loading = false;
      if (again && alive) {
        again = false;
        schedule();
      }
    }
  }
  function schedule(ms) {
    if (timer || !alive) return;
    timer = setTimeout(() => {
      timer = 0;
      refresh();
    }, ms == null ? 300 : ms);
  }
  jagents.onMessage("changed", () => schedule());
  for (const ev of ["panes-changed", "chats-changed"]) jagents.on(ev, () => schedule());
  // Maximize and restore: place or drop the tiles right away, then refresh.
  jagents.on("layout", () => {
    paintGutters();
    schedule();
  });
  const onResize = () => {
    schedule(150);
    closePop();
  };
  window.addEventListener("resize", onResize);
  const poll = setInterval(() => wanted() && schedule(), 5000);

  // ---- Show the page while JAgents marks our tab on ----

  let serversShown = false;
  function sync() {
    const on = tab.classList.contains("on");
    if (view.hidden === on) view.hidden = !on;
    if (side.hidden === on) side.hidden = !on;
    tab.setAttribute("aria-selected", String(on));
    if (on) {
      if (!serversShown) {
        serversShown = true;
        paintServers();
      }
      schedule(0);
    } else serversShown = false;
  }
  const watch = new MutationObserver(sync);
  watch.observe(tab, { attributes: true, attributeFilter: ["class"] });
  // Help was open, or JAgents restored this page from last time.
  if (helpWasOn || !seg.querySelector('[role="tab"].on')) tab.click();
  sync();
  schedule(0);

  return () => {
    alive = false;
    watch.disconnect();
    clearTimeout(timer);
    clearInterval(poll);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("mousedown", onDocDown, true);
    document.removeEventListener("scroll", onDocScroll, true);
    closePop();
    for (const el of [...gutters.keys()]) removeGutter(el);
    const wasOn = tab.classList.contains("on");
    tab.remove();
    side.remove();
    view.remove();
    if (helpTab) helpTab.hidden = false;
    if (wasOn) {
      const code = seg.querySelector('[data-mode="code"]');
      if (code) code.click();
    }
  };
}
