// Code mode: the active project's agents as tabs, in one or more groups side by
// side (or stacked). Each group has a tab strip at the top of the window with
// a + that opens the agent picker and a ⋯ menu; the active tab's pane fills
// the group. Pane views live as long as their pane does; switching tabs,
// projects or groups only moves or hides their elements.
//
// Groups are kept per project in the ui.groups setting:
//   { [projectKey]: { focused, groups: [{ id, tabs: [paneId], active }], tree } }
// tree arranges them: a leaf { g: groupId } or a split
// { dir: "row" | "column", kids: [node], sizes: [number] }, so any group can
// be split right or down.

import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, fire, on } from "./store.js";
import { TerminalView, terminalBusy } from "./terminal-view.js";
import { ChatView } from "./chat-view.js";
import { openHandoff, dropdown } from "./dialogs.js";
import { PluginPaneView, pluginKindIcon, openPluginsFromPane, openPluginPane } from "./plugins.js";
import { openNewTabPicker } from "./new-tab-picker.js";

const panes = new Map(); // paneId -> {pane, el, view, snap, exited}
let root = null;
let groupsEl = null;
let state = {}; // projectKey -> {dir, focused, groups}
let dragTab = "";
let saveTimer = 0;

export const projectKey = (dir) => String(dir || "").replace(/[\\/]+$/, "").replace(/\//g, "\\").toLowerCase();
const activeKey = () => projectKey(store.info.cwd);
const uid = () => "g" + Math.random().toString(36).slice(2, 9);

// Which project a pane belongs to. Panes with no folder (plugin panes from
// before projects) stay with the project that is open.
function paneProject(p) {
  return p.cwd ? projectKey(p.cwd) : "";
}

function projectPanes(key) {
  return store.panes.filter((p) => paneProject(p) === key || (!paneProject(p) && key === activeKey()));
}

export function projectCounts() {
  const out = new Map();
  for (const p of store.panes) {
    const k = paneProject(p) || activeKey();
    const e = out.get(k) || { count: 0, busy: 0 };
    e.count++;
    const entry = panes.get(p.id);
    const st = entry && entry.snap ? entry.snap.status : p.status;
    if (st === "busy" || st === "starting" || (p.kind === "terminal" && p.status !== "exited" && !(entry && entry.exited))) e.busy++;
    out.set(k, e);
  }
  return out;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => window.jagents.setSetting("ui.groups", state).catch(() => {}), 200);
}

// Brings the project's groups in line with its panes: closed panes leave
// their tabs, new panes join the focused group, empty groups go away.
function layoutFor(key) {
  const list = projectPanes(key).map((p) => p.id);
  const have = new Set(list);
  let s = state[key];
  if (!s || !Array.isArray(s.groups)) s = state[key] = { focused: "", groups: [], tree: null };
  // A group whose last tab closed goes away; one made empty on purpose stays.
  const emptied = new Set();
  for (const g of s.groups) {
    const had = (g.tabs || []).length;
    g.tabs = (g.tabs || []).filter((id) => have.has(id));
    if (had && !g.tabs.length) emptied.add(g);
    if (!g.tabs.includes(g.active)) g.active = g.tabs[0] || "";
  }
  if (s.groups.length > 1) s.groups = s.groups.filter((g) => !emptied.has(g));
  if (!s.groups.length) s.groups.push({ id: uid(), tabs: [], active: "" });
  if (!s.groups.some((g) => g.id === s.focused)) s.focused = s.groups[0].id;
  const placed = new Set(s.groups.flatMap((g) => g.tabs));
  const target = s.groups.find((g) => g.id === s.focused);
  for (const id of list) {
    if (placed.has(id)) continue;
    target.tabs.push(id);
    target.active = id;
  }
  fixTree(s);
  return s;
}

// Makes the tree hold every group exactly once: gone groups leave, splits
// with one child fold into it, and groups not in it (or a layout saved
// before splits had a direction each) join the root.
function fixTree(s) {
  const ids = new Set(s.groups.map((g) => g.id));
  const seen = new Set();
  const clean = (n) => {
    if (!n) return null;
    if (n.g) {
      if (!ids.has(n.g) || seen.has(n.g)) return null;
      seen.add(n.g);
      return n;
    }
    const kids = [];
    const sizes = [];
    (n.kids || []).forEach((k, i) => {
      const c = clean(k);
      if (!c) return;
      // A split inside one with the same direction joins it.
      if (!c.g && c.dir === n.dir) {
        const total = (n.sizes && n.sizes[i]) || 1;
        const sum = c.sizes.reduce((a, b) => a + b, 0) || 1;
        c.kids.forEach((kk, j) => {
          kids.push(kk);
          sizes.push((total * c.sizes[j]) / sum);
        });
        return;
      }
      kids.push(c);
      sizes.push((n.sizes && n.sizes[i]) || 1);
    });
    if (!kids.length) return null;
    if (kids.length === 1) return kids[0];
    return { dir: n.dir === "column" ? "column" : "row", kids, sizes };
  };
  let tree = s.tree ? clean(s.tree) : s.groups.length > 1 ? clean({ dir: s.dir || "row", kids: s.groups.map((g) => ({ g: g.id })), sizes: s.groups.map((g) => g.size || 1) }) : null;
  const missing = s.groups.filter((g) => !seen.has(g.id)).map((g) => ({ g: g.id }));
  if (!tree) tree = missing.length === 1 ? missing.shift() : missing.length ? { dir: "row", kids: missing.splice(0), sizes: [] } : null;
  if (missing.length) {
    if (tree.g || tree.dir !== "row") tree = { dir: "row", kids: [tree], sizes: [1] };
    tree.kids.push(...missing);
  }
  if (tree && !tree.g) tree.sizes = tree.kids.map((_, i) => tree.sizes[i] || 1);
  s.tree = tree;
  delete s.dir;
}

// The split holding a group's leaf, and the leaf's index in it.
function findLeaf(node, groupId, parent, index) {
  if (!node) return null;
  if (node.g) return node.g === groupId ? { parent, index, node } : null;
  for (let i = 0; i < node.kids.length; i++) {
    const hit = findLeaf(node.kids[i], groupId, node, i);
    if (hit) return hit;
  }
  return null;
}

// The group at the window's top-right corner, where the window buttons sit.
function topRight(node) {
  if (!node) return "";
  if (node.g) return node.g;
  return topRight(node.dir === "row" ? node.kids[node.kids.length - 1] : node.kids[0]);
}

function tabTitle(p, entry) {
  if (p.kind === "plugin") return p.title || p.name;
  if (p.kind === "terminal") return p.title && p.title !== p.name ? p.title : p.name + " · " + (p.handle || "");
  return (entry && entry.snap && entry.snap.title) || p.title || p.name;
}

function tabIcon(p, size) {
  if (p.kind === "plugin") return pluginKindIcon(p.pluginKind, size || 15);
  return harnessIcon(p.provider, size || 15);
}

// A terminal tab reads "Claude Code  claude-1": the agent, then its handle
// (what other agents call it) in a quieter style. A renamed one shows its name.
function tabParts(p, entry) {
  if (p.kind === "terminal" && !(p.title && p.title !== p.name)) return { name: p.name, sub: p.handle || "" };
  return { name: tabTitle(p, entry), sub: "" };
}

function tabMarkup(id, g) {
  const entry = panes.get(id);
  if (!entry) return "";
  const p = entry.pane;
  const { name, sub } = tabParts(p, entry);
  const label = sub ? name + " · " + sub : name;
  const on = g.active === id;
  return (
    '<div class="tab' + (on ? " on" : "") + (p.kind === "terminal" ? " term" : "") + '" role="tab" aria-selected="' + on + '" tabindex="' + (on ? 0 : -1) + '" draggable="true" data-tab="' + esc(id) + '">' +
    '<span class="tab-ic">' + tabIcon(p, 15) + "</span>" +
    '<span class="tab-title"><span class="tab-name">' + esc(name) + "</span>" + (sub ? '<span class="tab-sub">' + esc(sub) + "</span>" : "") + "</span>" +
    '<span class="tab-end"><span class="tab-state"></span>' +
    '<button type="button" class="tab-x" data-tab-close="' + esc(id) + '" aria-label="Close ' + esc(label) + '" title="Close (middle click)" tabindex="-1">' + icon("close", 13) + "</button></span></div>"
  );
}

// What a tab shows on its right: working, finished while you were elsewhere,
// waiting for your answer, or exited.
const STATE_TEXT = { busy: "Working", done: "Finished, not looked at yet", ask: "Waiting for your answer", exited: "Exited" };

function tabState(entry) {
  if (entry.exited) return "exited";
  const snap = entry.snap;
  if (snap && snap.permissions && snap.permissions.length) return "ask";
  if (snap ? snap.status === "busy" || snap.status === "starting" : terminalBusy(entry.pane.id)) return "busy";
  return entry.done ? "done" : "";
}

// States change often (a terminal starts and stops printing), so they are set
// on the tabs in place: a strip never rebuilds under the mouse or a drag.
function paintTabStates() {
  if (!groupsEl) return;
  for (const tab of groupsEl.querySelectorAll("[data-tab]")) {
    const entry = panes.get(tab.dataset.tab);
    if (!entry) continue;
    // Seen now (its project or group came into view).
    if (entry.done && onScreen(entry.pane.id)) entry.done = false;
    const st = tabState(entry);
    if ((tab.dataset.state || "") !== st) {
      if (st) tab.dataset.state = st;
      else delete tab.dataset.state;
    }
    const { name, sub } = tabParts(entry.pane, entry);
    const tip = [name + (st ? " (" + STATE_TEXT[st] + ")" : ""), sub, entry.pane.cwd].filter(Boolean).join("\n");
    if (tab.title !== tip) tab.title = tip;
  }
}

// On screen: the active tab of its group, in the open project, window showing.
function onScreen(id) {
  const g = groupOf(id);
  return Boolean(g && g.active === id && !document.hidden);
}

function noteDone(entry) {
  if (!onScreen(entry.pane.id)) entry.done = true;
}

on("term-activity", ({ id, busy, worked }) => {
  const entry = panes.get(id);
  if (!entry) return;
  // A few seconds of output is work worth a dot; a short redraw is not.
  if (!busy && worked >= 3000) noteDone(entry);
  paintTabStates();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  for (const [id, entry] of panes) if (entry.done && onScreen(id)) entry.done = false;
  paintTabStates();
});

// Keeps the active tab in view when a strip has more tabs than fit.
function revealActive(strip) {
  const tabs = strip.querySelector(".tabs");
  const on = tabs && tabs.querySelector(".tab.on");
  if (on) on.scrollIntoView({ block: "nearest", inline: "nearest" });
  fadeEdges(tabs);
}

// Faded edges show there are more tabs to scroll to.
function fadeEdges(tabs) {
  if (!tabs) return;
  tabs.classList.toggle("more-left", tabs.scrollLeft > 2);
  tabs.classList.toggle("more-right", tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 2);
}

function stripMarkup(g, last) {
  return (
    '<div class="tabs" role="tablist">' + g.tabs.map((id) => tabMarkup(id, g)).join("") + "</div>" +
    '<button type="button" class="strip-btn tab-add" data-menu-anchor data-group-add="' + esc(g.id) + '" title="New tab" aria-label="New tab">' + icon("plus", 15) + "</button>" +
    '<span class="strip-drag"></span>' +
    '<button type="button" class="strip-btn" data-menu-anchor data-group-more="' + esc(g.id) + '" title="More" aria-label="More">' + icon("more", 15) + "</button>" +
    (last ? '<span class="wco-space" aria-hidden="true"></span>' : "")
  );
}

function emptyMarkup() {
  const dir = store.info.cwd || "";
  const name = dir.replace(/^.*[\\/](?=[^\\/]+[\\/]?$)/, "") || dir;
  return (
    '<div class="group-empty"><div class="empty-inner">' +
    "<h1>" + esc(name || "New project") + "</h1>" +
    '<p class="muted">' + esc(dir) + "</p>" +
    '<p class="muted">Open an agent in this folder. Terminals run the real Claude Code, Codex and other CLIs; chats run Claude Code through the Agent SDK or ACP agents like Devin and Cursor.</p>' +
    '<button type="button" class="btn primary" data-menu-anchor data-empty-add>' + icon("plus", 16) + "New tab</button>" +
    "</div></div>"
  );
}

let lastSig = "";
let synced = false; // groups wait for the pane list, or a restart would drop them

function nodeHtml(node, path) {
  if (node.g) return '<section class="group" data-group="' + esc(node.g) + '"><header class="tabstrip"></header><div class="group-body grid-row"></div></section>';
  return (
    '<div class="split" data-dir="' + node.dir + '">' +
    node.kids
      .map((k, i) => (i ? '<div class="group-split" data-split="' + path + ":" + i + '" role="separator" aria-orientation="' + (node.dir === "column" ? "horizontal" : "vertical") + '"></div>' : "") + '<div class="split-cell" data-cell="' + path + ":" + i + '">' + nodeHtml(k, path + "." + i) + "</div>")
      .join("") +
    "</div>"
  );
}

const shape = (n) => (!n ? "" : n.g ? n.g : n.dir + "(" + n.kids.map(shape).join(",") + ")");

// Sizes go on the cells, so dragging a divider never rebuilds anything.
function applySizes(node, path) {
  if (!node || node.g) return;
  node.kids.forEach((k, i) => {
    const cell = groupsEl.querySelector('[data-cell="' + path + ":" + i + '"]');
    if (cell) cell.style.flex = String(node.sizes[i] || 1) + " 1 0";
    applySizes(k, path + "." + i);
  });
}

function render() {
  if (!groupsEl || !synced) return;
  const key = activeKey();
  const s = layoutFor(key);
  const sig = key + "|" + shape(s.tree);
  if (sig !== lastSig) {
    lastSig = sig;
    // Park every pane, rebuild the groups, then move panes back in.
    const park = root.querySelector(".parked");
    for (const { el } of panes.values()) park.appendChild(el);
    groupsEl.innerHTML = s.tree ? nodeHtml(s.tree, "r") : "";
  }
  applySizes(s.tree, "r");
  const corner = topRight(s.tree);
  const park = root.querySelector(".parked");
  s.groups.forEach((g) => {
    const gel = groupsEl.querySelector('[data-group="' + CSS.escape(g.id) + '"]');
    if (!gel) return;
    gel.classList.toggle("focused", g.id === s.focused && s.groups.length > 1);
    const strip = gel.querySelector(".tabstrip");
    const html = stripMarkup(g, g.id === corner);
    if (strip._html !== html) {
      strip._html = html;
      strip.innerHTML = html;
      const tabs = strip.querySelector(".tabs");
      tabs.addEventListener("scroll", () => fadeEdges(tabs), { passive: true });
      requestAnimationFrame(() => revealActive(strip));
    }
    const body = gel.querySelector(".group-body");
    for (const id of g.tabs) {
      const entry = panes.get(id);
      if (!entry) continue;
      if (entry.el.parentNode !== body) body.appendChild(entry.el);
      const on = id === g.active;
      if (entry.el.hidden === on) entry.el.hidden = !on;
      // Older plugins look for a maximized pane; a pane alone on screen is one.
      entry.el.classList.toggle("is-max", on && s.groups.length === 1);
    }
    let empty = body.querySelector(".group-empty");
    if (!g.tabs.length && !empty) body.insertAdjacentHTML("beforeend", emptyMarkup());
    else if (g.tabs.length && empty) empty.remove();
  });
  // Panes of other projects wait out of sight.
  const shown = new Set(s.groups.flatMap((g) => g.tabs));
  for (const [id, entry] of panes) if (!shown.has(id) && entry.el.parentNode !== park) park.appendChild(entry.el);
  paintTabStates();
  fire("app:layout");
  fire("code-tabs");
}

function groupOf(paneId) {
  const s = state[activeKey()];
  return s ? s.groups.find((g) => g.tabs.includes(paneId)) : null;
}

function focusGroup(id) {
  const s = state[activeKey()];
  if (!s || s.focused === id) return;
  s.focused = id;
  save();
  render();
}

function activate(paneId, focus) {
  const g = groupOf(paneId);
  if (!g) return false;
  g.active = paneId;
  const seen = panes.get(paneId);
  if (seen) seen.done = false;
  state[activeKey()].focused = g.id;
  save();
  render();
  const entry = panes.get(paneId);
  if (focus && entry && entry.view && entry.view.focus) setTimeout(() => entry.view.focus(), 0);
  return true;
}

function mount(pane) {
  const el = document.createElement("section");
  el.className = "pane " + pane.kind;
  el.dataset.pane = pane.id;
  el.innerHTML = '<div class="pane-body"></div>';
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
        const sig = (x) => (x ? x.status + "|" + x.title + "|" + ((x.permissions && x.permissions.length) || 0) : "");
        const before = sig(entry.snap);
        const wasBusy = Boolean(entry.snap && (entry.snap.status === "busy" || entry.snap.status === "starting"));
        entry.snap = snap;
        if (before !== sig(snap)) {
          if (wasBusy && snap.status !== "busy" && snap.status !== "starting") noteDone(entry);
          render();
          fire("project-counts");
        }
      },
    });
  el.addEventListener("click", (e) => openPluginsFromPane(e));
  el.addEventListener("mousedown", () => {
    const g = groupOf(pane.id);
    if (g) focusGroup(g.id);
  });
  return entry;
}

function agentFor(entry) {
  const p = entry.pane;
  return { id: p.kind === "chat" ? p.chatId : p.id, handle: p.handle, kind: p.kind, provider: p.provider, name: p.name };
}

async function closePane(id) {
  try {
    await window.jagents.panes.remove(id);
  } catch (error) {
    toast(errorText(error));
  }
}

export function syncPanes(list) {
  store.panes = list;
  synced = true;
  const ids = new Set(list.map((p) => p.id));
  for (const [id, entry] of panes) {
    if (!ids.has(id)) {
      entry.view.destroy();
      entry.el.remove();
      panes.delete(id);
    }
  }
  for (const p of list) {
    const entry = panes.get(p.id) || mount(p);
    entry.pane = Object.assign(entry.pane, p);
  }
  render();
  save();
  fire("panes", list);
  fire("project-counts");
}

export function markExited(id) {
  const e = panes.get(id);
  if (e) {
    e.exited = true;
    render();
    fire("project-counts");
  }
}

// Restart: the tab and project dot stop showing the terminal as exited.
on("terminal-restarted", (id) => {
  const e = panes.get(id);
  const p = store.panes.find((x) => x.id === id);
  if (p && p.status === "exited") p.status = "idle";
  if (e && e.exited) {
    e.exited = false;
    render();
    fire("project-counts");
  }
});

// Shows an agent's tab (switching project if it lives in another one).
export function focusAgent(ref) {
  const entry = Array.from(panes.values()).find((e) => e.pane.handle === ref || e.pane.id === ref || e.pane.chatId === ref);
  if (!entry) return false;
  const k = paneProject(entry.pane);
  if (k && k !== activeKey()) {
    fire("switch-project", entry.pane.cwd);
    setTimeout(() => focusAgent(ref), 50);
    return true;
  }
  activate(entry.pane.id, true);
  entry.el.classList.remove("flash");
  void entry.el.offsetWidth;
  entry.el.classList.add("flash");
  return true;
}

// New panes open in the group whose + was used.
function intoGroup(groupId) {
  const s = state[activeKey()];
  if (s && groupId) s.focused = groupId;
}

export async function addTerminal(provider) {
  try {
    const pane = await window.jagents.panes.addTerminal({ provider, cwd: store.info.cwd || undefined });
    setTimeout(() => focusAgent(pane.id), 150);
  } catch (error) {
    toast(errorText(error));
  }
}

export async function addChat(harnessId, chatId) {
  try {
    const pane = await window.jagents.panes.addChat(chatId ? { chatId } : { harnessId, cwd: store.info.cwd || undefined });
    setTimeout(() => focusAgent(pane.id), 150);
    return pane;
  } catch (error) {
    toast(errorText(error));
  }
}

function moveTab(id, toGroup, beforeId) {
  const s = state[activeKey()];
  const from = groupOf(id);
  const to = s.groups.find((g) => g.id === toGroup);
  if (!from || !to) return;
  from.tabs = from.tabs.filter((x) => x !== id);
  if (from.active === id) from.active = from.tabs[0] || "";
  const at = beforeId ? to.tabs.indexOf(beforeId) : -1;
  if (at >= 0) to.tabs.splice(at, 0, id);
  else to.tabs.push(id);
  to.active = id;
  s.focused = to.id;
  if (!from.tabs.length && s.groups.length > 1) s.groups = s.groups.filter((g) => g !== from);
  save();
  render();
}

// A new group to the right of (row) or below (column) a group, holding the
// tab id when one is given, otherwise empty with the new tab picker.
function splitWith(id, groupId, dir) {
  const s = state[activeKey()];
  const d = dir === "column" ? "column" : "row";
  const g = { id: uid(), tabs: [], active: "" };
  s.groups.push(g);
  const hit = findLeaf(s.tree, groupId, null, 0);
  const leaf = { g: g.id };
  if (!hit) s.tree = { dir: d, kids: [s.tree, leaf].filter(Boolean), sizes: [1, 1] };
  else if (hit.parent && hit.parent.dir === d) {
    // Same direction as its split: share the group's space with it.
    const half = (hit.parent.sizes[hit.index] || 1) / 2;
    hit.parent.sizes[hit.index] = half;
    hit.parent.kids.splice(hit.index + 1, 0, leaf);
    hit.parent.sizes.splice(hit.index + 1, 0, half);
  } else {
    const split = { dir: d, kids: [{ g: groupId }, leaf], sizes: [1, 1] };
    if (hit.parent) hit.parent.kids[hit.index] = split;
    else s.tree = split;
  }
  if (id) moveTab(id, g.id);
  else {
    s.focused = g.id;
    save();
    render();
  }
  return g;
}

// Merges a group into the one beside it: its tabs move over.
function closeGroup(groupId) {
  const s = state[activeKey()];
  if (s.groups.length < 2) return;
  const i = s.groups.findIndex((g) => g.id === groupId);
  const g = s.groups[i];
  const hit = findLeaf(s.tree, groupId, null, 0);
  let intoId = "";
  if (hit && hit.parent) {
    const first = (n) => (n.g ? n.g : first(n.kids[0]));
    intoId = first(hit.parent.kids[hit.index ? hit.index - 1 : 1]);
  }
  const into = s.groups.find((x) => x.id === intoId) || s.groups[i ? i - 1 : 1];
  into.tabs.push(...g.tabs);
  s.groups.splice(i, 1);
  s.focused = into.id;
  save();
  render();
}

function moreMenu(anchor, groupId, atTab) {
  const s = state[activeKey()];
  const g = s.groups.find((x) => x.id === groupId);
  const entry = g && g.active ? panes.get(g.active) : null;
  const items = [];
  if (entry) {
    const p = entry.pane;
    items.push({ section: tabTitle(p, entry) });
    if (p.kind !== "plugin") items.push({ label: "Hand off context…", desc: "Pass this agent's work to another agent", icon: '<span class="menu-ic">' + icon("handoff", 16) + "</span>", onPick: () => openHandoff(agentFor(entry), (res) => res && res.started && setTimeout(() => focusAgent(res.to), 300)) });
    if (p.kind === "terminal") items.push({ label: "Restart", desc: "Start " + p.name + " again in this tab", icon: '<span class="menu-ic">' + icon("restart", 16) + "</span>", onPick: () => entry.view.restart && entry.view.restart() });
    if (g.tabs.length > 1) {
      items.push({ label: "Split right", desc: "Move this tab to a new group on the right", icon: '<span class="menu-ic">' + icon("columns", 16) + "</span>", onPick: () => splitWith(p.id, g.id, "row") });
      items.push({ label: "Split down", desc: "Move this tab to a new group below", icon: '<span class="menu-ic">' + icon("rows", 16) + "</span>", onPick: () => splitWith(p.id, g.id, "column") });
    }
    if (g.tabs.length > 1) items.push({ label: "Close other tabs", icon: '<span class="menu-ic">' + icon("close", 16) + "</span>", onPick: () => g.tabs.filter((x) => x !== p.id).forEach(closePane) });
    items.push({ divider: true });
  }
  items.push({ section: "Layout" });
  items.push({ label: "New group right", desc: "An empty group beside this one", icon: '<span class="menu-ic">' + icon("columns", 16) + "</span>", onPick: () => splitWith("", g.id, "row") });
  items.push({ label: "New group below", desc: "An empty group under this one", icon: '<span class="menu-ic">' + icon("rows", 16) + "</span>", onPick: () => splitWith("", g.id, "column") });
  if (s.groups.length > 1) {
    const even = (n) => {
      if (!n || n.g) return;
      n.sizes = n.kids.map(() => 1);
      n.kids.forEach(even);
    };
    items.push({ label: "Even sizes", icon: '<span class="menu-ic">' + icon("grid", 16) + "</span>", onPick: () => { even(s.tree); save(); render(); } });
    items.push({ label: "Merge this group", desc: "Its tabs join the group beside it", icon: '<span class="menu-ic">' + icon("minimize", 16) + "</span>", onPick: () => closeGroup(g.id) });
  }
  dropdown(anchor, items, { width: 280, alignRight: !atTab });
}

function addFromPicker(anchor, groupId) {
  openNewTabPicker(anchor, {
    cwd: store.info.cwd,
    onPick: async (choice) => {
      intoGroup(groupId);
      if (choice.kind === "terminal") await addTerminal(choice.id);
      else if (choice.kind === "chat") await addChat(choice.id, choice.chatId);
      else if (choice.kind === "pair") {
        await addTerminal("claude");
        await addTerminal("codex");
      } else if (choice.kind === "plugin") await openPluginPane(choice.key, { state: choice.state, title: choice.title });
    },
  });
}

// Dragging a divider resizes the two cells on either side of it.
function nodeAt(path) {
  const s = state[activeKey()];
  let n = s.tree;
  for (const part of path.split(".").slice(1)) n = n && n.kids ? n.kids[Number(part)] : null;
  return n;
}

function startResize(e, ref) {
  const [path, idx] = ref.split(":");
  const index = Number(idx);
  const node = nodeAt(path);
  if (!node || node.g) return;
  const ca = groupsEl.querySelector('[data-cell="' + path + ":" + (index - 1) + '"]');
  const cb = groupsEl.querySelector('[data-cell="' + path + ":" + index + '"]');
  if (!ca || !cb) return;
  const col = node.dir === "column";
  const ra = ca.getBoundingClientRect();
  const rb = cb.getBoundingClientRect();
  const total = col ? ra.height + rb.height : ra.width + rb.width;
  const start = col ? e.clientY : e.clientX;
  const startA = col ? ra.height : ra.width;
  const sum = (node.sizes[index - 1] || 1) + (node.sizes[index] || 1);
  document.body.classList.add(col ? "resizing-rows" : "resizing-cols");
  const move = (ev) => {
    const d = (col ? ev.clientY : ev.clientX) - start;
    const pa = Math.min(0.9, Math.max(0.1, (startA + d) / total));
    node.sizes[index - 1] = sum * pa;
    node.sizes[index] = sum * (1 - pa);
    ca.style.flex = node.sizes[index - 1] + " 1 0";
    cb.style.flex = node.sizes[index] + " 1 0";
    fire("app:layout");
  };
  const up = () => {
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
    document.body.classList.remove("resizing-rows", "resizing-cols");
    save();
    window.dispatchEvent(new Event("resize"));
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
}

export function onRelayout() {
  render();
}

// The tabs of the open project, for the sidebar and plugins.
export function projectTabs() {
  const s = state[activeKey()];
  return s ? s.groups.flatMap((g) => g.tabs) : [];
}

export function showProject() {
  lastSig = "";
  render();
}

export function renderCodeMode(el) {
  root = el;
  state = (store.info.groups && typeof store.info.groups === "object" && store.info.groups) || {};
  el.innerHTML = '<div class="hub-banner" data-hub-banner hidden></div><div class="groups" data-groups></div><div class="parked" hidden></div>';
  groupsEl = el.querySelector("[data-groups]");

  el.addEventListener("click", (e) => {
    const t = e.target;
    const x = t.closest("[data-tab-close]");
    if (x) {
      e.stopPropagation();
      return closePane(x.dataset.tabClose);
    }
    const tab = t.closest("[data-tab]");
    if (tab) return activate(tab.dataset.tab, true);
    const add = t.closest("[data-group-add]");
    if (add) return addFromPicker(add, add.dataset.groupAdd);
    const more = t.closest("[data-group-more]");
    if (more) return moreMenu(more, more.dataset.groupMore);
    const empty = t.closest("[data-empty-add]");
    if (empty) {
      const g = empty.closest("[data-group]");
      return addFromPicker(empty, g && g.dataset.group);
    }
  });
  // Middle click closes a tab, like a browser.
  // Right-clicking a tab shows it and opens the group's ⋯ menu for it.
  el.addEventListener("contextmenu", (e) => {
    const tab = e.target.closest("[data-tab]");
    if (!tab) return;
    e.preventDefault();
    activate(tab.dataset.tab, false);
    // The strip was rebuilt; open the menu under the new tab element.
    const g = tab.closest("[data-group]") || groupsEl.querySelector('[data-group="' + CSS.escape((groupOf(tab.dataset.tab) || {}).id || "") + '"]');
    const now = g && g.querySelector('[data-tab="' + CSS.escape(tab.dataset.tab) + '"]');
    if (now) moreMenu(now, g.dataset.group, true);
  });
  // A mouse wheel scrolls a crowded strip sideways.
  el.addEventListener(
    "wheel",
    (e) => {
      const tabs = e.target.closest && e.target.closest(".tabs");
      if (!tabs || tabs.scrollWidth <= tabs.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      tabs.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  el.addEventListener("auxclick", (e) => {
    const tab = e.button === 1 && e.target.closest("[data-tab]");
    if (tab) closePane(tab.dataset.tab);
  });
  el.addEventListener("keydown", (e) => {
    const tab = e.target.closest && e.target.closest("[data-tab]");
    if (!tab) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(tab.dataset.tab, true);
    } else if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const all = Array.from(tab.parentElement.children);
      const i = all.indexOf(tab);
      const next = e.key === "Home" ? all[0] : e.key === "End" ? all[all.length - 1] : all[i + (e.key === "ArrowRight" ? 1 : -1)];
      if (next) next.focus();
    } else if (e.key === "Delete") closePane(tab.dataset.tab);
  });
  el.addEventListener("mousedown", (e) => {
    const sp = e.target.closest("[data-split]");
    if (sp) {
      e.preventDefault();
      startResize(e, sp.dataset.split);
      return;
    }
    const g = e.target.closest("[data-group]");
    if (g) focusGroup(g.dataset.group);
  });
  el.addEventListener("dblclick", (e) => {
    // Double-clicking a divider evens out the split it belongs to.
    const sp = e.target.closest("[data-split]");
    if (sp) {
      const node = nodeAt(sp.dataset.split.split(":")[0]);
      if (node && node.sizes) node.sizes = node.sizes.map(() => 1);
      save();
      render();
    }
  });

  // Tabs drag within a strip, to another group's strip, or onto a group.
  el.addEventListener("dragstart", (e) => {
    const tab = e.target.closest && e.target.closest("[data-tab]");
    if (!tab) return;
    dragTab = tab.dataset.tab;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragTab);
    tab.classList.add("dragging");
    root.classList.add("tab-dragging");
  });
  el.addEventListener("dragend", () => {
    dragTab = "";
    root.classList.remove("tab-dragging");
    for (const n of root.querySelectorAll(".dragging, .drop-before, .drop-into")) n.classList.remove("dragging", "drop-before", "drop-into");
  });
  el.addEventListener("dragover", (e) => {
    if (!dragTab) return;
    const g = e.target.closest("[data-group]");
    if (!g) return;
    e.preventDefault();
    for (const n of root.querySelectorAll(".drop-before, .drop-into")) n.classList.remove("drop-before", "drop-into");
    const tab = e.target.closest("[data-tab]");
    if (tab && tab.dataset.tab !== dragTab) tab.classList.add("drop-before");
    else if (!tab) g.classList.add("drop-into");
  });
  el.addEventListener("drop", (e) => {
    if (!dragTab) return;
    const g = e.target.closest("[data-group]");
    if (!g) return;
    e.preventDefault();
    const tab = e.target.closest("[data-tab]");
    const id = dragTab;
    dragTab = "";
    moveTab(id, g.dataset.group, tab && tab.dataset.tab !== id ? tab.dataset.tab : "");
  });

  // Ctrl+Tab and Ctrl+Shift+Tab (or Ctrl+PageDown and PageUp) go through the
  // focused group's tabs, from anywhere in Code mode.
  document.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.altKey || e.metaKey || !root.offsetParent) return;
    const fwd = e.key === "Tab" ? !e.shiftKey : e.key === "PageDown" ? true : e.key === "PageUp" ? false : null;
    if (fwd === null || document.querySelector(".modal-back, .settings-page:not([hidden])")) return;
    const s = state[activeKey()];
    const g = s && (s.groups.find((x) => x.id === s.focused) || s.groups[0]);
    if (!g || g.tabs.length < 2) return;
    e.preventDefault();
    const i = g.tabs.indexOf(g.active);
    activate(g.tabs[(i + (fwd ? 1 : -1) + g.tabs.length) % g.tabs.length], true);
  });

  new ResizeObserver(() => {
    fire("app:layout");
    for (const t of groupsEl.querySelectorAll(".tabs")) fadeEdges(t);
  }).observe(groupsEl);
  on("hub-agents", () => render());
  on("plugin-kinds", () => render());
  render();
}
