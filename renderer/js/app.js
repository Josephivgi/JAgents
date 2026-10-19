import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, fire, on, refreshAgents, refreshChats } from "./store.js";
import { routeAcpState, routeAcpModels } from "./chat-view.js";
import { routePtyData, routePtyExit, retheme } from "./terminal-view.js";
import { renderCodeMode, syncPanes, addTerminal, addChat, setLayout, getLayout, notePtyData, markExited, focusAgent } from "./code-mode.js";
import { renderThreadMode, noteThreadState, openThread } from "./thread-mode.js";
import { dropdown, openHubPanel, updateActivity } from "./dialogs.js";
import { initPlugins, openPluginsPanel, pluginKinds, openPluginPane } from "./plugins.js";

const app = document.getElementById("app");
let mode = "code";
let activity = [];

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.info.theme = theme;
  retheme();
  fire("app:theme", theme);
}

function topbarMarkup() {
  return (
    '<div class="brand"><img class="brand-mark" src="icon.svg" alt="" width="22" height="22">Relay</div>' +
    '<div class="seg mode-seg" role="tablist" aria-label="Mode">' +
    '<button role="tab" data-mode="code">' + icon("grid", 15) + "Code</button>" +
    '<button role="tab" data-mode="threads">' + icon("chat", 15) + "Threads</button></div>" +
    '<button class="folder-pill" data-folder title="Working folder for new agents">' + icon("folder", 15) + '<span data-cwd></span></button>' +
    '<span class="spacer"></span>' +
    '<div class="code-actions">' +
    '<button class="btn sm primary add-pane" data-menu-anchor data-add-pane title="Add a terminal or chat" aria-label="Add a terminal or chat">' + icon("plus", 16) + "</button>" +
    '<div class="seg layout-seg" aria-label="Layout">' +
    '<button data-layout="grid" title="Even grid">' + icon("grid", 15) + "</button>" +
    '<button data-layout="columns" title="Side by side">' + icon("columns", 15) + "</button>" +
    '<button data-layout="rows" title="Stacked">' + icon("rows", 15) + "</button></div></div>" +
    '<div class="plugin-top" data-plugin-top></div>' +
    '<button class="hub-pill" data-hub title="MCP hub">' + icon("hub", 15) + '<span data-hub-label>MCP hub</span><span class="status-dot" data-hub-dot></span></button>' +
    '<button class="icon-btn" data-theme-toggle title="Toggle theme"></button>'
  );
}

function paintTopbar() {
  for (const b of app.querySelectorAll("[data-mode]")) b.classList.toggle("on", b.dataset.mode === mode);
  for (const b of app.querySelectorAll("[data-layout]")) b.classList.toggle("on", b.dataset.layout === getLayout());
  app.querySelector(".code-actions").hidden = mode !== "code";
  const cwd = store.info.cwd || "";
  app.querySelector("[data-cwd]").textContent = cwd.replace(/^.*[\\/](?=[^\\/]+[\\/]?$)/, "") || cwd;
  app.querySelector("[data-folder]").title = "Working folder for new agents: " + cwd;
  app.querySelector("[data-hub-label]").textContent = store.info.hubAttach ? "MCP hub on" : "MCP hub off";
  app.querySelector("[data-hub-dot]").className = "status-dot " + (store.info.hubAttach ? "ok" : "");
  app.querySelector("[data-theme-toggle]").innerHTML = icon(store.info.theme === "dark" ? "sun" : "moon", 16);
}

function setMode(next) {
  mode = next;
  window.relay.setSetting("mode", next);
  app.querySelector("[data-code-side]").hidden = next !== "code";
  app.querySelector("[data-thread-side]").hidden = next !== "threads";
  app.querySelector("[data-code-main]").hidden = next !== "code";
  app.querySelector("[data-thread-main]").hidden = next !== "threads";
  paintTopbar();
  if (next === "code") window.dispatchEvent(new Event("resize"));
}

function statusTone(a) {
  if (a.status === "busy" || a.status === "starting") return "busy";
  if (a.status === "error" || a.status === "exited") return "error";
  if (a.status === "ready" || a.status === "idle") return "ok";
  return "";
}

// Code-mode sidebar: every agent the hub knows, subagents nested under the
// agent that spawned them, then the agent-to-agent activity feed.
function paintAgents() {
  const box = app.querySelector("[data-agents]");
  if (!box) return;
  const list = store.hubAgents;
  const ids = new Set(list.map((a) => a.id));
  const roots = list.filter((a) => !a.parentId || !ids.has(a.parentId));
  const row = (a, depth) =>
    '<button class="agent-item" data-agent="' + esc(a.handle) + '" style="--depth:' + depth + '">' +
    (depth ? '<span class="tree">' + icon("subagent", 12) + "</span>" : "") +
    harnessIcon(a.provider, 16) +
    '<span class="grow"><span class="t">' + esc(a.handle) + '</span><span class="s">' + esc(a.kind === "terminal" ? a.name : a.title || a.name) + "</span></span>" +
    (a.mcp ? '<span class="mini-hub" title="Has relay MCP tools">' + icon("hub", 12) + "</span>" : "") +
    '<span class="status-dot ' + statusTone(a) + '" title="' + esc(a.status) + '"></span></button>';
  const walk = (a, depth) => row(a, depth) + list.filter((c) => c.parentId === a.id).map((c) => walk(c, depth + 1)).join("");
  box.innerHTML = roots.length ? roots.map((a) => walk(a, 0)).join("") : '<p class="nav-empty">No agents running.</p>';
  const actBox = app.querySelector("[data-side-activity]");
  actBox.innerHTML = activity.length
    ? activity
        .slice(-8)
        .reverse()
        .map((e) => '<div class="side-act"><b>' + esc(e.from) + "</b> " + (e.type === "message" ? "→" : e.type === "spawn" ? "spawned" : e.type === "handoff" ? "handed off to" : esc(e.type)) + " <b>" + esc(e.to) + "</b>" + (e.text ? '<span class="act-text">' + esc(e.text.slice(0, 90)) + "</span>" : "") + "</div>")
        .join("")
    : '<p class="nav-empty">Messages, spawns, and handoffs between agents show here.</p>';
}

async function refreshHubAgents() {
  try {
    store.hubAgents = await window.relay.hub.agents();
    paintAgents();
    fire("hub-agents", store.hubAgents);
  } catch {
    /* app closing */
  }
}

function paintBanner() {
  const b = app.querySelector("[data-hub-banner]");
  if (!b) return;
  b.hidden = Boolean(store.info.hubChosen);
  if (b.hidden) return;
  b.innerHTML =
    icon("hub", 18) +
    '<div class="grow"><b>Let these agents see each other?</b> The Relay MCP hub lets Claude Code, Codex and chat agents list and message each other, read each other\'s work, spawn subagents, and hand off context.</div>' +
    '<button class="btn sm primary" data-banner="on">Connect agents</button><button class="btn sm ghost" data-banner="details">Details</button><button class="btn sm ghost" data-banner="off">Not now</button>';
}

// The + menu: every way to add a pane to the split. Installed agents first;
// native chats (Claude Code through the Agent SDK) lead the chat list.
function addMenu(anchor) {
  const byAvail = (a, b) => Number(b.available) - Number(a.available);
  const items = [{ section: "Terminal" }];
  for (const t of store.terminalAgents.slice().sort(byAvail)) items.push({ label: t.name, desc: t.available ? t.description : t.install, icon: harnessIcon(t.id, 18), disabled: !t.available, badge: t.available ? "" : "Not installed", onPick: () => addTerminal(t.id) });
  const both = store.terminalAgents.filter((t) => (t.id === "claude" || t.id === "codex") && t.available);
  if (both.length === 2) items.push({ label: "Claude Code + Codex", desc: "Two terminals, split evenly", icon: harnessIcon("codex", 18), onPick: async () => { await addTerminal("claude"); await addTerminal("codex"); } });
  items.push({ section: "Chat" });
  const chats = store.acpAgents.slice().sort((a, b) => byAvail(a, b) || Number(Boolean(b.native)) - Number(Boolean(a.native)));
  for (const a of chats) items.push({ label: a.name, desc: a.available ? (a.native ? "Native, through the Claude Agent SDK" : "ACP agent") : a.install, icon: harnessIcon(a.id, 18), disabled: !a.available, badge: a.available ? (a.native ? "Native" : "") : "Not installed", onPick: () => addChat(a.id) });
  const open = new Set(store.panes.filter((p) => p.kind === "chat").map((p) => p.chatId));
  const threads = store.chats.filter((c) => !open.has(c.id)).slice(0, 5);
  if (threads.length) {
    items.push({ section: "Open a thread" });
    for (const c of threads) items.push({ label: c.title, desc: c.handle, icon: harnessIcon(c.harnessId, 18), onPick: () => addChat("", c.id) });
  }
  const kinds = pluginKinds();
  if (kinds.length) {
    items.push({ section: "From plugins" });
    for (const k of kinds) items.push({ label: k.title, desc: k.description || "From the " + k.pluginId + " plugin", icon: '<span class="menu-ic">' + (String(k.icon || "").trim().startsWith("<svg") ? k.icon : icon(k.icon || "puzzle", 18)) + "</span>", onPick: () => openPluginPane(k.key) });
  }
  dropdown(anchor, items, { width: 340, alignRight: true });
}

function onEvent({ type, payload }) {
  fire("app:" + type, payload);
  if (type === "pty-data") {
    notePtyData(payload.id);
    routePtyData(payload);
  } else if (type === "pty-exit") {
    routePtyExit(payload);
    markExited(payload.id);
  } else if (type === "acp-state") {
    routeAcpState(payload);
    noteThreadState(payload);
    const c = store.chats.find((x) => x.id === payload.chatId);
    if (c && c.title !== payload.title) {
      c.title = payload.title;
      fire("chats", store.chats);
    }
  } else if (type === "acp-models") routeAcpModels(payload);
  else if (type === "panes-changed") {
    syncPanes(payload);
    refreshHubAgents();
  } else if (type === "chats-changed") refreshChats();
  else if (type === "hub-activity") {
    activity = payload;
    paintAgents();
    updateActivity(payload);
  } else if (type === "toast") toast(payload.text);
}

async function boot() {
  store.info = await window.relay.appInfo();
  setTheme(store.info.theme);
  await Promise.all([refreshAgents(), refreshChats()]);
  mode = store.info.mode === "threads" ? "threads" : "code";
  app.innerHTML =
    '<header class="topbar">' + topbarMarkup() + "</header>" +
    '<div class="body">' +
    '<aside class="sidebar">' +
    '<div data-code-side class="side-pane"><p class="nav-label">Agents</p><div class="agent-list" data-agents></div><div class="plugin-side" data-plugin-side hidden></div><p class="nav-label">Activity</p><div class="side-activity" data-side-activity></div></div>' +
    '<div data-thread-side class="side-pane" hidden></div>' +
    '<section class="sidebar-plugins" aria-labelledby="plugins-title" data-plugin-card>' +
    '<div class="plugins-card-head">' + icon("puzzle", 16) + '<div class="grow"><h2 id="plugins-title">Plugins</h2><p class="muted small" data-plugin-summary>Loading</p></div></div>' +
    '<button type="button" class="btn sm secondary block" data-plugins>Manage plugins</button>' +
    "</section>" +
    "</aside>" +
    '<main class="main"><div class="code-mode" data-code-main></div><div class="thread-mode" data-thread-main hidden></div></main>' +
    "</div>";
  renderCodeMode(app.querySelector("[data-code-main]"));
  renderThreadMode(app.querySelector("[data-thread-side]"), app.querySelector("[data-thread-main]"), {
    splitThread: async (chatId) => {
      await addChat("", chatId);
      setMode("code");
      setTimeout(() => focusAgent(chatId), 250);
    },
  });
  syncPanes(await window.relay.panes.list());
  activity = await window.relay.hub.activity();
  setMode(mode);
  paintBanner();
  refreshHubAgents();
  setInterval(refreshHubAgents, 2000);
  window.relay.onEvent(onEvent);
  initPlugins().catch((error) => toast("Plugins could not load: " + errorText(error)));
  on("hub", () => {
    paintTopbar();
    paintBanner();
  });

  app.addEventListener("click", async (e) => {
    const t = e.target;
    const m = t.closest("[data-mode]");
    if (m) return setMode(m.dataset.mode);
    const l = t.closest("[data-layout]");
    if (l) {
      setLayout(l.dataset.layout);
      return paintTopbar();
    }
    if (t.closest("[data-add-pane]")) return addMenu(t.closest("[data-add-pane]"));
    if (t.closest("[data-hub]")) return openHubPanel();
    if (t.closest("[data-plugins]")) return openPluginsPanel();
    if (t.closest("[data-theme-toggle]")) {
      const next = store.info.theme === "dark" ? "light" : "dark";
      setTheme(next);
      window.relay.setSetting("theme", next);
      return paintTopbar();
    }
    if (t.closest("[data-folder]")) {
      try {
        const dir = await window.relay.pickFolder();
        if (dir) {
          store.info.cwd = dir;
          paintTopbar();
          toast("New agents start in " + dir);
        }
      } catch (error) {
        toast(errorText(error));
      }
      return;
    }
    const agent = t.closest("[data-agent]");
    if (agent) {
      const a = store.hubAgents.find((x) => x.handle === agent.dataset.agent);
      if (a && !focusAgent(a.handle) && a.kind === "chat") {
        setMode("threads");
        openThread(a.id);
      }
      return;
    }
    const banner = t.closest("[data-banner]");
    if (banner) {
      const v = banner.dataset.banner;
      if (v === "details") return openHubPanel();
      store.info.hubChosen = true;
      await window.relay.setSetting("hub.chosen", true);
      if (v === "on") {
        store.info.hubAttach = true;
        await window.relay.setSetting("hub.attach", true);
        toast("New agents get the relay MCP server. Restart open terminals to connect them.");
      }
      fire("hub", store.info);
    }
  });
  paintTopbar();
}

boot().catch((error) => {
  app.innerHTML = '<div class="fatal"><h1>Relay could not start</h1><pre>' + esc(errorText(error)) + "</pre></div>";
});
