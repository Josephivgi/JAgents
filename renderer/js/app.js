import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, fire, on, refreshAgents, refreshChats } from "./store.js";
import { routeAcpState, routeAcpModels } from "./chat-view.js";
import { routePtyData, routePtyExit, retheme } from "./terminal-view.js";
import { renderCodeMode, syncPanes, addChat, markExited, focusAgent, projectCounts, showProject, activeWorkspace, DEFAULT_WS } from "./code-mode.js";
import { renderThreadMode, noteThreadState, openThread } from "./thread-mode.js";
import { initUsage, noteUsage } from "./usage.js";
import { dropdown, updateActivity } from "./dialogs.js";
import { renderHelpMode, refreshHelp } from "./help-mode.js";
import { initPlugins } from "./plugins.js";
import { initChatPolish } from "./chat-polish.js";
import { openSettings, closeSettings, settingsOpen, refreshSettings } from "./settings.js";
import { noteUpdate } from "./update-popup.js";

const app = document.getElementById("app");
let mode = "code";
let activity = [];
let seenActivity = 0;

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.info.theme = theme;
  retheme();
  fire("app:theme", theme);
  // Windows draws the window buttons; give them this theme's colors.
  requestAnimationFrame(() => {
    const cs = getComputedStyle(document.documentElement);
    const color = toHex(cs.getPropertyValue("--strip-bg")) || (theme === "dark" ? "#111111" : "#ffffff");
    const symbolColor = toHex(cs.getPropertyValue("--ink")) || (theme === "dark" ? "#e4e4e7" : "#3f3f46");
    window.jagents.titlebarColors({ color, symbolColor }).catch(() => {});
  });
}

// CSS colors (oklch included) as #rrggbb, through a canvas.
function toHex(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  const c = document.createElement("canvas").getContext("2d");
  c.fillStyle = "#000";
  c.fillStyle = v;
  c.fillRect(0, 0, 1, 1);
  const [r, g, b] = c.getImageData(0, 0, 1, 1).data;
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}
on("set-theme", (theme) => {
  setTheme(theme);
  window.jagents.setSetting("theme", theme);
});

// Page tabs: at most pageTabs() share the strip; more scroll sideways, with a
// thin scrollbar under them. Tabs plugins add to the strip (Subagents, the
// Plugins page) are fitted the same way whenever they arrive.
const pageTabs = () => Math.min(6, Math.max(1, Math.round(Number(store.info.pageTabs)) || 3));
let fitQueued = false;
let tightAt = 0; // strip width at which the labels stopped fitting with icons
let tightKey = "";
const BUILTIN_MODES = ["code", "threads", "help"];
const modeTab = (m) => app.querySelector('.mode-seg [data-mode="' + CSS.escape(m) + '"]');

function fitModes() {
  fitQueued = false;
  const seg = app.querySelector(".mode-seg");
  if (!seg) return;
  // A plugin tab that left out role or type still lines up with the others.
  // Bare text next to an icon goes in a label span, so a long name ends in an
  // ellipsis instead of being cut at both ends. A tab that is only text is
  // left as it is (CSS ellipsizes it), so a plugin that compares its tab's
  // HTML before writing does not see a change every time.
  for (const t of seg.children) {
    if (!t.getAttribute("role")) t.setAttribute("role", "tab");
    if (t.tagName === "BUTTON" && !t.getAttribute("type")) t.setAttribute("type", "button");
    if (!t.firstElementChild) continue;
    for (const n of Array.from(t.childNodes)) {
      if (n.nodeType !== Node.TEXT_NODE || !n.textContent.trim()) continue;
      const label = document.createElement("span");
      label.className = "mode-label";
      n.replaceWith(label);
      label.appendChild(n);
    }
  }
  // A plugin page that reloaded put its tab back: it is still the open page.
  const cur = modeTab(mode);
  if (cur && !cur.classList.contains("on")) paintModes();
  const tabs = Array.from(seg.children).filter((t) => !t.hidden && t.getAttribute("role") === "tab");
  const isCut = (el) => Boolean(el && el.scrollWidth > el.clientWidth + 1);
  const labelsOf = (t) => (t.firstElementChild ? Array.from(t.querySelectorAll(".mode-label")) : [t]);
  const shown = tabs.length;
  if (seg.style.getPropertyValue("--page-tabs") !== String(pageTabs())) seg.style.setProperty("--page-tabs", String(pageTabs()));
  seg.classList.toggle("scroll-x", shown > pageTabs());
  // Four or more tabs side by side leave no room for icons, and neither do
  // three in a narrow sidebar: then the icons go and labels end in "…".
  let tight = Math.min(shown, pageTabs()) > 3;
  if (!tight && !seg.classList.contains("scroll-x")) {
    const key = tabs.map((t) => t.textContent).join("|");
    if (tightAt && key === tightKey && seg.clientWidth <= tightAt) tight = true;
    else {
      tightAt = 0;
      seg.classList.remove("tight");
      if (tabs.some((t) => labelsOf(t).some(isCut))) {
        tight = true;
        tightAt = seg.clientWidth;
        tightKey = key;
      }
    }
  }
  seg.classList.toggle("tight", tight);
  // Screen readers hear which page is open; arrow keys move between tabs.
  const onTab = tabs.find((t) => t.classList.contains("on")) || tabs[0];
  for (const t of tabs) {
    const sel = t.classList.contains("on");
    if (t.getAttribute("aria-selected") !== String(sel)) t.setAttribute("aria-selected", String(sel));
    const ti = t === onTab ? "0" : "-1";
    if (t.getAttribute("tabindex") !== ti) t.setAttribute("tabindex", ti);
    // A cut label shows in full as the tooltip, and follows the label when
    // its text changes.
    const cut = labelsOf(t).some(isCut);
    const text = t.textContent.trim();
    if (cut && (!t.title || t.dataset.autoTitle)) {
      if (t.title !== text) t.title = text;
      t.dataset.autoTitle = "1";
    } else if (!cut && t.dataset.autoTitle) {
      t.removeAttribute("title");
      delete t.dataset.autoTitle;
    }
  }
  const on = seg.querySelector('[role="tab"].on');
  if (on && seg.classList.contains("scroll-x")) {
    const a = on.offsetLeft - seg.scrollLeft;
    if (a < 0 || a + on.offsetWidth > seg.clientWidth) seg.scrollTo({ left: on.offsetLeft - 2 });
  }
}

const queueFit = () => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(fitModes);
};

function watchModes() {
  const seg = app.querySelector(".mode-seg");
  new MutationObserver(queueFit).observe(seg, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden"] });
  // The mouse wheel scrolls the tabs sideways.
  seg.addEventListener(
    "wheel",
    (e) => {
      if (!seg.classList.contains("scroll-x") || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      seg.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  seg.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabs = Array.from(seg.querySelectorAll('[role="tab"]')).filter((t) => !t.hidden);
    const i = tabs.indexOf(e.target.closest('[role="tab"]'));
    if (i < 0) return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[n].focus();
    tabs[n].click();
    tabs[n].scrollIntoView({ block: "nearest", inline: "nearest" });
  });
  on("page-tabs", queueFit);
  // A plugin page that was turned off or removed leaves no tab: go back to Code
  // instead of an empty window.
  on("plugins", () => {
    if (!BUILTIN_MODES.includes(mode) && !modeTab(mode)) setMode("code");
    revealProject();
  });
  queueFit();
}

function paintModes() {
  for (const b of app.querySelectorAll(".mode-seg [data-mode]")) b.classList.toggle("on", b.dataset.mode === mode);
  queueFit();
}

function setMode(next) {
  mode = next;
  closeSettings();
  document.body.dataset.mode = next;
  window.jagents.setSetting("mode", next);
  app.querySelector("[data-code-side]").hidden = next !== "code";
  app.querySelector("[data-thread-side]").hidden = next !== "threads";
  app.querySelector("[data-code-main]").hidden = next !== "code";
  app.querySelector("[data-thread-main]").hidden = next !== "threads";
  app.querySelector("[data-help-side]").hidden = next !== "help";
  app.querySelector("[data-help-main]").hidden = next !== "help";
  if (next === "help") refreshHelp();
  paintModes();
  if (next === "code") window.dispatchEvent(new Event("resize"));
  // Pane and page views check again in this same task: a native view never
  // stays over the page that was just opened, and a page's own view shows at once.
  fire("app:layout");
}

// ---- Projects -------------------------------------------------------------

const keyOf = (dir) => String(dir || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();

function parentDir(dir) {
  const d = String(dir || "").replace(/[\\/]+$/, "").replace(/\//g, "\\");
  const i =Math.max(d.lastIndexOf("\\"), d.lastIndexOf("/"));
  return i > 0 ? d.slice(0, i) : d;
}

function paintProjects() {
  const box = app.querySelector("[data-projects]");
  if (!box) return;
  const counts = projectCounts();
  const active = keyOf(store.info.cwd);
  const list = store.projects || [];
  const html = list.length
    ? list
        .map((p) => {
          const c = counts.get(keyOf(p.path));
          const on = keyOf(p.path) === active;
          return (
            '<button type="button" class="project' + (on ? " on" : "") + '" data-project="' + esc(p.path) + '" title="' + esc(p.path) + '"' + (on ? ' aria-current="true"' : "") + ">" +
            '<span class="project-ic">' + icon("folder", 15) + "</span>" +
            '<span class="project-text"><span class="project-name">' + esc(p.name) + '</span><span class="project-path">' + esc(parentDir(p.path)) + "</span></span>" +
            countPill(c) +
            "</button>" +
            workspaceRows(p, on, counts)
          );
        })
        .join("")
    : '<p class="nav-empty">Add a folder to start agents in it.</p>';
  if (box._html !== html) {
    box._html = html;
    box.innerHTML = html;
  }
  if (box._active !== active) revealProject();
  box._active = active;
}

// Keep the open project in view in the list (plugin sections below can leave
// it only a few rows).
function revealProject() {
  const box = app.querySelector("[data-projects]");
  const on = box && box.querySelector(".project.on");
  if (!on) return;
  const r = on.getBoundingClientRect();
  const b = box.getBoundingClientRect();
  if (r.top < b.top) box.scrollTop -= b.top - r.top;
  else if (r.bottom > b.bottom) box.scrollTop += Math.min(r.bottom - b.bottom, r.top - b.top);
}

function countPill(c) {
  return c && c.count ? '<span class="project-count" title="' + c.count + (c.count === 1 ? " agent" : " agents") + (c.busy ? ", " + c.busy + " running" : "") + '">' + c.count + "</span>" : "";
}

// A project's workspaces, under it: each its own set of agents. A project with
// only Default shows just "New workspace", and only while it is open.
function workspaceRows(p, open, counts) {
  const list = p.workspaces || [];
  if (list.length < 2 && !open) return "";
  const current = p.workspace || DEFAULT_WS;
  const rows = list.length < 2 ? [] : list.map((w) => {
    const on = open && w.id === current;
    return (
      '<button type="button" class="ws-row' + (on ? " on" : "") + '" data-ws="' + esc(w.id) + '" data-ws-dir="' + esc(p.path) + '"' + (on ? ' aria-current="true"' : "") + ">" +
      '<span class="ws-ic">' + icon(w.id === DEFAULT_WS ? "grid" : "columns", 13) + "</span>" +
      '<span class="ws-name">' + esc(w.name) + "</span>" +
      countPill(counts.get(keyOf(p.path) + "#" + w.id)) +
      "</button>"
    );
  });
  if (open) rows.push('<button type="button" class="ws-row ws-add" data-ws-add="' + esc(p.path) + '"><span class="ws-ic">' + icon("plus", 13) + '</span><span class="ws-name">New workspace</span></button>');
  return '<div class="ws-list" role="group" aria-label="Workspaces in ' + esc(p.name) + '">' + rows.join("") + "</div>";
}

async function switchWorkspace(dir, id) {
  const same = keyOf(dir) === keyOf(store.info.cwd) && activeWorkspace() === id;
  if (same) {
    if (mode !== "code") setMode("code");
    return;
  }
  try {
    store.projects = await window.jagents.projects.activateWorkspace(dir, id);
    store.info.cwd = dir;
    if (mode !== "code") setMode("code");
    showProject();
    paintProjects();
    window.dispatchEvent(new Event("resize"));
  } catch (error) {
    toast(errorText(error));
  }
}

async function newWorkspace(dir) {
  try {
    store.projects = await window.jagents.projects.addWorkspace(dir);
    store.info.cwd = dir;
    if (mode !== "code") setMode("code");
    showProject();
    paintProjects();
    const p = store.projects.find((x) => keyOf(x.path) === keyOf(dir));
    if (p) renameWorkspace(p, p.workspace);
  } catch (error) {
    toast(errorText(error));
  }
}

function workspaceMenu(anchor, dir, id) {
  const p = (store.projects || []).find((x) => keyOf(x.path) === keyOf(dir));
  const w = p && (p.workspaces || []).find((x) => x.id === id);
  if (!w) return;
  const count = (projectCounts().get(keyOf(dir) + "#" + id) || { count: 0 }).count;
  const items = [
    { section: w.name + " · " + p.name },
    { label: "Open", icon: '<span class="menu-ic">' + icon("columns", 16) + "</span>", onPick: () => switchWorkspace(dir, id) },
  ];
  if (id !== DEFAULT_WS) {
    items.push({ label: "Rename…", icon: '<span class="menu-ic">' + icon("pencil", 16) + "</span>", onPick: () => renameWorkspace(p, id) });
    items.push({
      label: "Remove workspace",
      desc: count ? "Close its " + count + (count === 1 ? " agent" : " agents") + " first" : "Its layout goes; the folder stays",
      icon: '<span class="menu-ic">' + icon("trash", 16) + "</span>",
      disabled: count > 0,
      onPick: () => window.jagents.projects.removeWorkspace(dir, id).then(refreshProjects).catch((e) => toast(errorText(e))),
    });
  }
  items.push({ label: "New workspace", icon: '<span class="menu-ic">' + icon("plus", 16) + "</span>", onPick: () => newWorkspace(dir) });
  dropdown(anchor, items, { width: 260 });
}

function renameWorkspace(p, id) {
  const w = (p.workspaces || []).find((x) => x.id === id);
  const row = app.querySelector('[data-ws="' + CSS.escape(id) + '"][data-ws-dir="' + CSS.escape(p.path) + '"] .ws-name');
  if (!w || !row || id === DEFAULT_WS) return;
  const input = document.createElement("input");
  input.className = "project-rename ws-rename";
  input.value = w.name;
  input.maxLength = 40;
  input.setAttribute("aria-label", "Workspace name");
  row.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (ok && name && name !== w.name) {
      try {
        store.projects = await window.jagents.projects.renameWorkspace(p.path, id, name);
      } catch (error) {
        toast(errorText(error));
      }
    }
    app.querySelector("[data-projects]")._html = "";
    paintProjects();
    // The empty workspace screen shows its name.
    if (keyOf(p.path) === keyOf(store.info.cwd)) showProject();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

async function refreshProjects(list) {
  try {
    const wsBefore = activeWorkspace();
    store.projects = list || (await window.jagents.projects.list());
    const active = store.projects.find((p) => p.active);
    if (active && keyOf(active.path) !== keyOf(store.info.cwd)) {
      store.info.cwd = active.path;
      showProject();
    } else if (activeWorkspace() !== wsBefore) showProject();
  } catch {
    /* closing */
  }
  paintProjects();
  fire("projects", store.projects);
}

async function switchProject(dir) {
  if (keyOf(dir) === keyOf(store.info.cwd)) {
    if (mode !== "code") setMode("code");
    return;
  }
  try {
    store.projects = await window.jagents.projects.activate(dir);
    store.info.cwd = dir;
    if (mode !== "code") setMode("code");
    showProject();
    paintProjects();
    window.dispatchEvent(new Event("resize"));
  } catch (error) {
    toast(errorText(error));
  }
}

async function addProject() {
  try {
    const list = await window.jagents.projects.add();
    if (!list) return;
    const active = list.find((p) => p.active);
    store.projects = list;
    if (active) {
      store.info.cwd = active.path;
      if (mode !== "code") setMode("code");
      showProject();
    }
    paintProjects();
  } catch (error) {
    toast(errorText(error));
  }
}

function projectMenu(anchor, dir) {
  const p = (store.projects || []).find((x) => keyOf(x.path) === keyOf(dir));
  if (!p) return;
  const count = (projectCounts().get(keyOf(dir)) || { count: 0 }).count;
  dropdown(
    anchor,
    [
      { section: p.name },
      { label: "Open", icon: '<span class="menu-ic">' + icon("folder", 16) + "</span>", onPick: () => switchProject(p.path) },
      { label: "Show in Explorer", icon: '<span class="menu-ic">' + icon("external", 16) + "</span>", onPick: () => window.jagents.openPath(p.path).catch((e) => toast(errorText(e))) },
      { label: "Rename…", icon: '<span class="menu-ic">' + icon("pencil", 16) + "</span>", onPick: () => renameProject(p) },
      { label: "New workspace", desc: "A separate set of agents in this folder", icon: '<span class="menu-ic">' + icon("plus", 16) + "</span>", onPick: () => newWorkspace(p.path) },
      { label: "Remove from list", desc: count ? "Close its " + count + (count === 1 ? " agent" : " agents") + " first" : "The folder stays on disk", icon: '<span class="menu-ic">' + icon("trash", 16) + "</span>", disabled: count > 0, onPick: () => window.jagents.projects.remove(p.path).then(refreshProjects).catch((e) => toast(errorText(e))) },
    ],
    { width: 260 },
  );
}

function renameProject(p) {
  const row = app.querySelector('[data-project="' + CSS.escape(p.path) + '"] .project-name');
  if (!row) return;
  const input = document.createElement("input");
  input.className = "project-rename";
  input.value = p.name;
  input.setAttribute("aria-label", "Project name");
  row.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return;
    done = true;
    if (ok && input.value.trim() && input.value.trim() !== p.name) {
      try {
        store.projects = await window.jagents.projects.rename(p.path, input.value.trim());
      } catch (error) {
        toast(errorText(error));
      }
    }
    app.querySelector("[data-projects]")._html = "";
    paintProjects();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
}

// ---- Activity (agent-to-agent messages) in the dock -----------------------

function paintActivityBadge() {
  const b = app.querySelector("[data-activity-badge]");
  if (!b) return;
  const n = Math.max(0, activity.length - seenActivity);
  b.hidden = n === 0;
  b.textContent = n > 9 ? "9+" : String(n);
}

function activityMenu(anchor) {
  seenActivity = activity.length;
  paintActivityBadge();
  const verb = (e) => (e.type === "message" ? "→" : e.type === "spawn" ? "spawned" : e.type === "handoff" ? "handed off to" : e.type);
  const items = [{ section: "Agent activity" }];
  if (!activity.length) items.push({ label: "Nothing yet", desc: "Messages, spawns and handoffs between agents show here.", disabled: true });
  for (const e of activity.slice(-12).reverse())
    items.push({ label: e.from + " " + verb(e) + " " + e.to, desc: (e.text || "").slice(0, 120), icon: '<span class="menu-ic">' + icon(e.type === "spawn" ? "subagent" : e.type === "handoff" ? "handoff" : "hub", 16) + "</span>", onPick: () => focusAgent(e.to) || toast(e.to + " is not open.") });
  dropdown(anchor, items, { width: 340, up: true });
}

function onEvent({ type, payload }) {
  fire("app:" + type, payload);
  if (type === "pty-data") {
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
  } else if (type === "projects-changed") refreshProjects(payload);
  else if (type === "chats-changed") refreshChats();
  else if (type === "hub-activity") {
    activity = payload;
    paintActivityBadge();
    updateActivity(payload);
  } else if (type === "update-status") {
    store.update = payload;
    noteUpdate(payload);
    fire("update", payload);
  } else if (type === "usage") noteUsage(payload);
  else if (type === "toast") toast(payload.text);
}

async function refreshHubAgents() {
  try {
    store.hubAgents = await window.jagents.hub.agents();
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
    '<div class="grow"><b>Let these agents see each other?</b> The JAgents MCP hub lets Claude Code, Codex and chat agents list and message each other, read each other\'s work, spawn subagents, and hand off context.</div>' +
    '<button class="btn sm primary" data-banner="on">Connect agents</button><button class="btn sm ghost" data-banner="details">Details</button><button class="btn sm ghost" data-banner="off">Not now</button>';
}

// A notification or a subagent card asked to show a chat: its tab when one is
// open, otherwise the thread.
on("open-chat", (chatId) => {
  if (focusAgent(chatId)) {
    if (mode !== "code") setMode("code");
    return;
  }
  setMode("threads");
  openThread(chatId);
});
on("switch-project", (dir) => switchProject(dir));
on("switch-workspace", ({ dir, workspace }) => switchWorkspace(dir, workspace));
on("open-help", (section) => {
  setMode("help");
  const el = document.getElementById("help-" + (section || "workspace"));
  if (el) el.scrollIntoView({ block: "start" });
});
on("set-mode", (m) => setMode(m));
on("project-counts", () => paintProjects());

function sidebarWidth(px) {
  const w = Math.min(420, Math.max(200, Math.round(px)));
  document.documentElement.style.setProperty("--side-w", w + "px");
  return w;
}

// Room for the window buttons Windows draws over the top-right corner.
function fitWindowControls() {
  const wco = navigator.windowControlsOverlay;
  if (!wco || !wco.visible) return document.documentElement.style.setProperty("--wco-w", "0px");
  const r = wco.getTitlebarAreaRect();
  document.documentElement.style.setProperty("--wco-w", Math.max(0, Math.round(window.innerWidth - r.right)) + "px");
}
if (navigator.windowControlsOverlay) navigator.windowControlsOverlay.addEventListener("geometrychange", fitWindowControls);
window.addEventListener("resize", fitWindowControls);

async function boot() {
  fitWindowControls();
  store.info = await window.jagents.appInfo();
  store.projects = store.info.projects || [];
  setTheme(store.info.theme);
  await Promise.all([refreshAgents(), refreshChats()]);
  mode = ["threads", "help"].includes(store.info.mode) ? store.info.mode : "code";
  if (store.info.sidebarWidth) sidebarWidth(store.info.sidebarWidth);
  app.innerHTML =
    '<div class="body">' +
    '<aside class="sidebar">' +
    '<div class="side-top"><div class="seg mode-seg" role="tablist" aria-label="Mode">' +
    '<button role="tab" data-mode="code">' + icon("grid", 14) + "Code</button>" +
    '<button role="tab" data-mode="threads">' + icon("chat", 14) + "Threads</button></div></div>" +
    '<div data-code-side class="side-pane">' +
    '<div class="side-head"><p class="nav-label">Projects</p><button type="button" class="icon-btn side-add" data-project-add title="Add a project folder" aria-label="Add a project folder">' + icon("plus", 15) + "</button></div>" +
    '<div class="project-list" data-projects role="list"></div>' +
    '<div class="plugin-side" data-plugin-side hidden></div></div>' +
    '<div data-thread-side class="side-pane" hidden></div>' +
    '<div data-help-side class="side-pane" hidden></div>' +
    // The dock: activity, usage, settings and plugin buttons, then usage bars.
    // (.sidebar-updates stays as the hook plugins insert sidebar sections above.)
    '<section class="side-dock sidebar-updates" aria-label="Activity, usage and settings">' +
    '<div class="dock-bar"><div class="dock-icons">' +
    '<button type="button" class="dock-icon" data-menu-anchor data-activity title="Agent activity" aria-label="Agent activity">' + icon("tree", 15) + '<span class="dock-badge" data-activity-badge hidden></span></button>' +
    '<button type="button" class="dock-icon" data-usage-open title="Usage for every agent" aria-label="Usage">' + icon("usage", 15) + "</button>" +
    '<button type="button" class="dock-icon" data-settings title="Settings" aria-label="Settings">' + icon("gear", 15) + '<span class="dock-flag" data-settings-badge hidden>' + icon("update", 11) + "</span></button>" +
    '<span class="plugin-top" data-plugin-top></span>' +
    '<button type="button" class="dock-icon dock-more" data-menu-anchor data-dock-more title="More plugin buttons" aria-label="More plugin buttons" hidden>' + icon("more", 15) + "</button></div>" +
    // Check usage now keeps the top-right corner however many rows the icons take.
    '<button type="button" class="dock-icon" data-usage-refresh title="Check usage now" aria-label="Check usage now">' + icon("restart", 14) + "</button></div>" +
    '<div class="dock-usage" data-usage><button type="button" class="usage-rows" data-usage-open data-usage-rows title="Usage for every agent"></button><p class="dock-sub" data-usage-summary></p></div>' +
    "</section>" +
    '<div class="side-resize" data-side-resize role="separator" aria-orientation="vertical" aria-label="Resize sidebar"></div>' +
    "</aside>" +
    '<main class="main"><div class="code-mode" data-code-main></div><div class="thread-mode" data-thread-main hidden></div><div class="help-mode" data-help-main hidden></div><div class="settings-page" data-settings-main hidden></div></main>' +
    "</div>";
  renderCodeMode(app.querySelector("[data-code-main]"));
  renderThreadMode(app.querySelector("[data-thread-side]"), app.querySelector("[data-thread-main]"), {
    splitThread: async (chatId) => {
      const chat = store.chats.find((c) => c.id === chatId);
      if (chat && chat.cwd && keyOf(chat.cwd) !== keyOf(store.info.cwd)) await switchProject(chat.cwd);
      await addChat("", chatId);
      setMode("code");
      setTimeout(() => focusAgent(chatId), 250);
    },
  });
  renderHelpMode(app.querySelector("[data-help-side]"), app.querySelector("[data-help-main]"));
  initUsage(app.querySelector(".side-dock"));
  syncPanes(await window.jagents.panes.list());
  activity = await window.jagents.hub.activity();
  seenActivity = activity.length;
  setMode(mode);
  paintProjects();
  // The list gets smaller when plugin sections or the window take room: keep
  // the open project in view.
  new ResizeObserver(() => revealProject()).observe(app.querySelector("[data-projects]"));
  paintBanner();
  refreshHubAgents();
  setInterval(refreshHubAgents, 2000);
  window.jagents.updates.state().then((u) => {
    store.update = u;
    noteUpdate(u);
    fire("update", u);
  }).catch(() => {});
  window.jagents.onEvent(onEvent);
  initChatPolish();
  initPlugins().catch((error) => toast("Plugins could not load: " + errorText(error)));
  on("hub", () => {
    paintBanner();
    refreshSettings();
  });
  on("update", (u) => {
    const flag = app.querySelector("[data-settings-badge]");
    const ready = Boolean(u && (u.available || u.applied));
    if (flag) flag.hidden = !ready;
    const gear = app.querySelector(".dock-icon[data-settings]");
    if (gear) {
      gear.title = ready ? "Settings (update available)" : "Settings";
      gear.setAttribute("aria-label", gear.title);
    }
  });

  // The sidebar's right edge resizes it.
  app.querySelector("[data-side-resize]").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const side = app.querySelector(".sidebar");
    const start = e.clientX;
    const w0 = side.getBoundingClientRect().width;
    let w = w0;
    document.body.classList.add("resizing-cols");
    const move = (ev) => {
      w = sidebarWidth(w0 + ev.clientX - start);
      window.dispatchEvent(new Event("resize"));
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.classList.remove("resizing-cols");
      window.jagents.setSetting("ui.sidebarWidth", w).catch(() => {});
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });

  app.addEventListener("contextmenu", (e) => {
    const w = e.target.closest("[data-ws]");
    if (w) {
      e.preventDefault();
      return workspaceMenu(w, w.dataset.wsDir, w.dataset.ws);
    }
    const p = e.target.closest("[data-project]");
    if (!p) return;
    e.preventDefault();
    projectMenu(p, p.dataset.project);
  });

  app.addEventListener("click", async (e) => {
    const t = e.target;
    const m = t.closest(".mode-seg [data-mode]");
    if (m) return setMode(m.dataset.mode);
    const w = t.closest("[data-ws]");
    if (w) return switchWorkspace(w.dataset.wsDir, w.dataset.ws);
    const wa = t.closest("[data-ws-add]");
    if (wa) return newWorkspace(wa.dataset.wsAdd);
    const p = t.closest("[data-project]");
    if (p) return switchProject(p.dataset.project);
    if (t.closest("[data-project-add]")) return addProject();
    if (t.closest("[data-activity]")) return activityMenu(t.closest("[data-activity]"));
    if (t.closest("[data-settings]")) return settingsOpen() ? closeSettings() : openSettings();
    const banner = t.closest("[data-banner]");
    if (banner) {
      const v = banner.dataset.banner;
      if (v === "details") return openSettings("hub");
      store.info.hubChosen = true;
      await window.jagents.setSetting("hub.chosen", true);
      if (v === "on") {
        store.info.hubAttach = true;
        await window.jagents.setSetting("hub.attach", true);
        toast("New agents get the jagents MCP server. Restart open terminals to connect them.");
      }
      fire("hub", store.info);
    }
  });
  paintModes();
  watchModes();
}

boot()
  .catch((error) => {
    app.innerHTML = '<div class="fatal"><h1>JAgents could not start</h1><pre>' + esc(errorText(error)) + "</pre></div>";
  })
  .finally(() => window.jagents.ready());
