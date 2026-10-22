// Settings: a page over the main area with everything that used to sit in the
// top bar and the sidebar dock: theme, projects, agents (the marketplace), the
// MCP hub, updates, plugins, usage, the guide, and about. The app's existing
// panels draw on this page (dialogs.embedNextModal) instead of in popups.

import { esc, toast, errorText } from "./util.js";
import { icon } from "./icons.js";
import { store, fire, on } from "./store.js";
import { embedNextModal, openHubPanel, openUpdatesPanel } from "./dialogs.js";
import { openPluginsPanel } from "./plugins.js";
import { openMarketplace } from "./marketplace.js";
import { openUsagePanel } from "./usage.js";

const SECTIONS = [
  { id: "general", label: "General", icon: "gear" },
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "agents", label: "Agents", icon: "store" },
  { id: "hub", label: "MCP hub", icon: "hub" },
  { id: "updates", label: "Updates", icon: "update" },
  { id: "plugins", label: "Plugins", icon: "puzzle" },
  { id: "usage", label: "Usage", icon: "usage" },
  { id: "guide", label: "Guide", icon: "help" },
  { id: "about", label: "About", icon: "agent" },
];

let page = null;
let current = "general";

export function settingsOpen() {
  return Boolean(page && !page.hidden);
}

export function closeSettings() {
  if (!page || page.hidden) return;
  page.hidden = true;
  page.querySelector("[data-set-body]").innerHTML = "";
  document.body.classList.remove("settings-on");
  for (const b of document.querySelectorAll("[data-settings]")) b.classList.remove("on");
  fire("app:layout");
}

export function openSettings(section) {
  page = document.querySelector("[data-settings-main]");
  if (!page) return;
  if (!page.dataset.wired) wire();
  if (section) current = section;
  page.hidden = false;
  document.body.classList.add("settings-on");
  for (const b of document.querySelectorAll("[data-settings]")) b.classList.add("on");
  show(current);
  fire("app:layout");
}

export function refreshSettings() {
  if (settingsOpen() && (current === "general" || current === "projects" || current === "about")) show(current);
}

function wire() {
  page.dataset.wired = "1";
  page.innerHTML =
    '<header class="set-top"><h1>' + icon("gear", 17) + "Settings</h1>" +
    '<span class="strip-drag"></span>' +
    '<button type="button" class="strip-btn" data-set-close title="Close settings (Esc)" aria-label="Close settings">' + icon("close", 15) + "</button>" +
    '<span class="wco-space" aria-hidden="true"></span></header>' +
    '<div class="set-wrap"><nav class="set-nav" aria-label="Settings sections">' +
    SECTIONS.map((s) => '<button type="button" data-set-nav="' + s.id + '">' + icon(s.icon, 15) + "<span>" + esc(s.label) + '</span><span class="set-dot" data-set-dot="' + s.id + '" hidden></span></button>').join("") +
    '</nav><div class="set-body" data-set-body></div></div>';
  page.addEventListener("click", onClick);
  page.addEventListener("change", onChange);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && settingsOpen() && !document.querySelector(".modal-back, .news-menu.dropdown")) closeSettings();
  });
  on("update", paintDots);
  on("plugins", paintDots);
  on("projects", () => settingsOpen() && current === "projects" && show("projects"));
  paintDots();
}

function paintDots() {
  if (!page) return;
  const u = store.update || {};
  const set = (id, on) => {
    const d = page.querySelector('[data-set-dot="' + id + '"]');
    if (d) d.hidden = !on;
  };
  set("updates", Boolean(u.available || u.applied));
  const st = store.plugins || { plugins: [] };
  set("plugins", Boolean(st.safeMode || (st.plugins || []).some((p) => p.enabled && p.errors && (p.errors.main || p.errors.renderer || p.errors.mcp))));
}

function row(title, desc, control) {
  return '<div class="set-row"><div class="set-row-text"><b>' + esc(title) + "</b>" + (desc ? '<span class="muted small">' + desc + "</span>" : "") + '</div><div class="set-row-ctl">' + control + "</div></div>";
}

function toggle(attr, on, label) {
  return '<button type="button" role="switch" class="switch' + (on ? " on" : "") + '" ' + attr + ' aria-checked="' + on + '" aria-label="' + esc(label) + '"></button>';
}

function generalHtml() {
  const t = store.info.theme;
  return (
    '<h2 class="set-h">General</h2>' +
    '<div class="set-card">' +
    row("Theme", "Colors for the whole window, terminals included.", '<div class="seg" role="radiogroup" aria-label="Theme"><button type="button" role="radio" aria-checked="' + (t === "dark") + '" class="' + (t === "dark" ? "on" : "") + '" data-set-theme="dark">' + icon("moon", 14) + 'Dark</button><button type="button" role="radio" aria-checked="' + (t === "light") + '" class="' + (t === "light" ? "on" : "") + '" data-set-theme="light">' + icon("sun", 14) + "Light</button></div>") +
    row("New agents start in", "The open project's folder. Pick a project in the sidebar to change it.", '<span class="mono small set-path" title="' + esc(store.info.cwd || "") + '">' + esc(store.info.cwd || "") + "</span>") +
    row("Agents see each other", "The JAgents MCP hub gives terminal agents tools to list, message and hand off to other agents.", toggle("data-set-hub", Boolean(store.info.hubAttach), "MCP hub")) +
    "</div>"
  );
}

function projectsHtml() {
  const list = store.projects || [];
  return (
    '<h2 class="set-h">Projects</h2><p class="muted set-lead">A project is a folder. Its agents open as tabs, and new agents start in the open project\'s folder.</p>' +
    '<div class="set-card">' +
    (list.length
      ? list
          .map(
            (p) =>
              '<div class="set-row"><span class="project-ic">' + icon("folder", 15) + '</span><div class="set-row-text"><b>' + esc(p.name) + (p.active ? ' <span class="pill ok">Open</span>' : "") + '</b><span class="muted small mono">' + esc(p.path) + "</span></div>" +
              '<div class="set-row-ctl"><button type="button" class="btn sm ghost" data-set-reveal="' + esc(p.path) + '">' + icon("external", 14) + "Show</button>" +
              (p.active ? "" : '<button type="button" class="btn sm secondary" data-set-open="' + esc(p.path) + '">Open</button>') +
              '<button type="button" class="icon-btn" data-set-remove="' + esc(p.path) + '" title="Remove from the list" aria-label="Remove ' + esc(p.name) + '">' + icon("trash", 14) + "</button></div></div>",
          )
          .join("")
      : '<p class="muted small">No projects yet.</p>') +
    "</div>" +
    '<button type="button" class="btn primary" data-set-add-project>' + icon("plus", 15) + "Add a project folder</button>"
  );
}

function updatesHead() {
  return (
    '<div class="set-card set-pre">' +
    row("Check for updates automatically", "JAgents checks GitHub when it starts and every 6 hours, and reminds you when a new version is out.", toggle("data-set-autoupdate", store.info.updateAuto !== false, "Check for updates automatically")) +
    "</div>"
  );
}

function guideHtml() {
  return (
    '<h2 class="set-h">Guide</h2>' +
    '<div class="set-card">' +
    row("How JAgents works", "Projects and tabs, chats and terminals, the MCP hub, subagents, handoffs, and plugins.", '<button type="button" class="btn secondary" data-set-guide>' + icon("help", 14) + "Open the guide</button>") +
    row("Safe mode", "If a plugin breaks the window, press Ctrl+Shift+F12 to turn every plugin off and reload.", "") +
    "</div>"
  );
}

function aboutHtml() {
  const u = store.update || {};
  return (
    '<h2 class="set-h">About</h2>' +
    '<div class="set-card about-card"><img src="icon.svg" width="56" height="56" alt=""><div><b>JAgents</b><span class="muted">Version ' + esc(store.info.version || "") + (u.available ? " · " + esc(u.latest) + " available" : "") + '</span><span class="muted small mono">' + esc(store.info.dataRoot || "") + "</span></div></div>" +
    '<div class="set-card">' +
    row("Data folder", "Threads, settings and plugins live here, in SQLite.", '<button type="button" class="btn sm ghost" data-set-reveal="' + esc(store.info.dataRoot || "") + '">' + icon("external", 14) + "Show</button>") +
    row("Picker design", "The new tab picker and tab strip are adapted from Orca (MIT license, Lovecast Inc.).", "") +
    "</div>"
  );
}

async function show(id) {
  current = id;
  for (const b of page.querySelectorAll("[data-set-nav]")) {
    const on = b.dataset.setNav === id;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  const body = page.querySelector("[data-set-body]");
  body.scrollTop = 0;
  body.innerHTML = "";
  const host = () => {
    const el = document.createElement("div");
    el.className = "set-embed";
    body.appendChild(el);
    embedNextModal(el);
    return el;
  };
  try {
    if (id === "general") body.innerHTML = generalHtml();
    else if (id === "projects") body.innerHTML = projectsHtml();
    else if (id === "guide") body.innerHTML = guideHtml();
    else if (id === "about") body.innerHTML = aboutHtml();
    // The panels bring their own heading.
    else if (id === "updates") {
      host();
      await openUpdatesPanel(false);
      body.insertAdjacentHTML("beforeend", updatesHead());
    } else if (id === "hub") {
      host();
      await openHubPanel();
    } else if (id === "plugins") {
      host();
      await openPluginsPanel();
    } else if (id === "agents") {
      host();
      await openMarketplace();
    } else if (id === "usage") {
      host();
      openUsagePanel();
    }
  } catch (error) {
    body.insertAdjacentHTML("beforeend", '<p class="err-row">' + esc(errorText(error)) + "</p>");
  }
  paintDots();
}

async function onClick(e) {
  const t = e.target;
  const nav = t.closest("[data-set-nav]");
  if (nav) return show(nav.dataset.setNav);
  if (t.closest("[data-set-close]")) return closeSettings();
  const th = t.closest("[data-set-theme]");
  if (th) {
    fire("set-theme", th.dataset.setTheme);
    return show("general");
  }
  const sw = t.closest("[data-set-hub]");
  if (sw) {
    const next = !store.info.hubAttach;
    store.info.hubAttach = next;
    store.info.hubChosen = true;
    await window.jagents.setSetting("hub.attach", next);
    await window.jagents.setSetting("hub.chosen", true);
    fire("hub", store.info);
    if (next) toast("New agents get the jagents MCP server. Restart open terminals to connect them.");
    return show("general");
  }
  const au = t.closest("[data-set-autoupdate]");
  if (au) {
    store.info.updateAuto = !(store.info.updateAuto !== false);
    await window.jagents.setSetting("update.auto", store.info.updateAuto);
    au.setAttribute("aria-checked", String(store.info.updateAuto));
    au.classList.toggle("on", Boolean(store.info.updateAuto));
    return;
  }
  const rv = t.closest("[data-set-reveal]");
  if (rv) return window.jagents.openPath(rv.dataset.setReveal).catch((error) => toast(errorText(error)));
  const op = t.closest("[data-set-open]");
  if (op) {
    fire("switch-project", op.dataset.setOpen);
    return;
  }
  const rm = t.closest("[data-set-remove]");
  if (rm) {
    try {
      store.projects = await window.jagents.projects.remove(rm.dataset.setRemove);
      fire("projects", store.projects);
      fire("project-counts");
    } catch (error) {
      toast(errorText(error));
    }
    return show("projects");
  }
  if (t.closest("[data-set-add-project]")) {
    try {
      const list = await window.jagents.projects.add();
      if (list) {
        store.projects = list;
        const a = list.find((p) => p.active);
        if (a) fire("switch-project", a.path);
      }
    } catch (error) {
      toast(errorText(error));
    }
    return;
  }
  if (t.closest("[data-set-guide]")) {
    fire("open-help");
  }
}

function onChange() {}
