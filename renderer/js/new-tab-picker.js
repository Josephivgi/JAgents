// The "+" menu on a tab strip: the v0.5 add list (terminals, chats, threads,
// plugin tabs) with each agent's logo. The title and a search box stay pinned
// at the top while the long list scrolls under them.
import { esc } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store } from "./store.js";
import { pluginKinds } from "./plugins.js";
import { openMarketplace } from "./marketplace.js";

let current = null; // {el, anchor, close}

const URLISH = /^(https?:\/\/\S+|localhost(:\d+)?(\/\S*)?|[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?)$/i;

function menuIcon(svg) {
  return '<span class="menu-ic">' + svg + "</span>";
}

// The rows, in the old menu's order. `words` is what the search box matches.
function buildItems() {
  const byAvail = (a, b) => Number(b.available) - Number(a.available);
  const items = [{ section: "Terminal" }];
  for (const t of store.terminalAgents.slice().sort(byAvail)) {
    items.push({ label: t.name, desc: t.available ? t.description : t.install, icon: harnessIcon(t.id, 18), disabled: !t.available, badge: t.available ? "" : "Not installed", words: t.id + " terminal cli", choice: { kind: "terminal", id: t.id } });
  }
  const both = store.terminalAgents.filter((t) => (t.id === "claude" || t.id === "codex") && t.available);
  if (both.length === 2) items.push({ label: "Claude Code + Codex", desc: "Two terminals, split evenly", icon: harnessIcon("codex", 18), words: "pair claude codex", choice: { kind: "pair" } });

  items.push({ section: "Chat" });
  const chats = store.acpAgents.slice().sort((a, b) => byAvail(a, b) || Number(Boolean(b.native)) - Number(Boolean(a.native)));
  for (const a of chats) {
    items.push({ label: a.name, desc: a.available ? (a.native ? "Native, through the Claude Agent SDK" : "ACP agent") : a.install, icon: harnessIcon(a.id, 18), disabled: !a.available, badge: a.available ? (a.native ? "Native" : "") : "Not installed", words: a.id + " chat acp", choice: { kind: "chat", id: a.id } });
  }
  items.push({ label: "Get more agents…", desc: "Install agents from the marketplace", icon: menuIcon(icon("store", 18)), words: "marketplace install", run: () => openMarketplace() });

  const open = new Set(store.panes.filter((p) => p.kind === "chat").map((p) => p.chatId));
  const threads = store.chats.filter((c) => !open.has(c.id)).slice(0, 5);
  if (threads.length) {
    items.push({ section: "Open a thread" });
    for (const c of threads) items.push({ label: c.title, desc: c.handle, icon: harnessIcon(c.harnessId, 18), words: "thread", choice: { kind: "chat", id: "", chatId: c.id } });
  }

  const kinds = pluginKinds();
  if (kinds.length) {
    items.push({ section: "From plugins" });
    for (const k of kinds) {
      const svg = String(k.icon || "").trim().startsWith("<svg") ? k.icon : icon(k.icon || "puzzle", 18);
      items.push({ label: k.title, desc: k.description || "From the " + k.pluginId + " plugin", icon: menuIcon(svg), words: k.key + (k.key === "browser:tab" ? " web url page" : ""), choice: { kind: "plugin", key: k.key } });
    }
  }
  return items;
}

// Filters the rows; a section stays only if something under it matches.
function filtered(items, q) {
  if (!q) return items;
  const parts = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  let section = null;
  for (const it of items) {
    if (it.section) {
      section = it;
      continue;
    }
    const hay = [it.label, it.desc, it.badge, it.words].join(" ").toLowerCase();
    if (!parts.every((p) => hay.includes(p))) continue;
    if (section) {
      out.push(section);
      section = null;
    }
    out.push(it);
  }
  const text = q.trim();
  if (URLISH.test(text) && items.some((it) => it.choice && it.choice.key === "browser:tab")) {
    const url = /^https?:\/\//i.test(text) ? text : (text.startsWith("localhost") ? "http://" : "https://") + text;
    out.unshift({ label: "Open " + url, desc: "In a browser tab", icon: menuIcon(icon("globe", 18)), choice: { kind: "plugin", key: "browser:tab", state: { url }, title: url } });
  }
  return out;
}

export function closeNewTabPicker() {
  if (current) current.close();
}

export function openNewTabPicker(anchor, opts) {
  const o = opts || {};
  if (current) {
    const same = current.anchor === anchor;
    current.close();
    if (same) return;
  }
  const all = buildItems();
  let shown = all;
  const el = document.createElement("div");
  el.className = "news-menu dropdown add-menu";
  el.setAttribute("role", "menu");
  el.setAttribute("aria-label", "Add a tab");
  el.innerHTML =
    '<div class="add-menu-head">' +
    '<p class="add-menu-title">Add a tab</p>' +
    '<label class="menu-search">' + icon("search", 15) + '<input type="text" spellcheck="false" placeholder="Search agents, threads, or type a URL" aria-label="Search"></label>' +
    "</div>" +
    '<div class="add-menu-list"></div>';
  document.body.appendChild(el);
  const input = el.querySelector("input");
  const list = el.querySelector(".add-menu-list");

  function paint() {
    shown = filtered(all, input.value.trim());
    list.innerHTML = shown.length
      ? shown
          .map((it, i) => {
            if (it.section) return '<p class="news-menu-label">' + esc(it.section) + "</p>";
            return (
              '<button type="button" role="menuitem" class="news-menu-row agent-row' + (it.disabled ? " is-missing" : "") + '" data-i="' + i + '"' + (it.disabled ? " disabled" : "") + ">" +
              (it.icon || "") +
              '<span class="news-menu-text"><span class="news-menu-name" title="' + esc(it.label) + '">' + esc(it.label) + "</span>" + (it.desc ? '<span class="news-menu-desc">' + esc(it.desc) + "</span>" : "") + "</span>" +
              (it.badge ? '<span class="agent-badge">' + esc(it.badge) + "</span>" : "") +
              "</button>"
            );
          })
          .join("")
      : '<p class="add-menu-empty">Nothing matches.</p>';
  }

  function rows() {
    return Array.from(list.querySelectorAll(".news-menu-row:not(:disabled)"));
  }

  function run(i) {
    const it = shown[i];
    if (!it || it.disabled) return;
    close();
    if (it.run) return it.run();
    if (o.onPick) o.onPick(it.choice);
  }

  // Under the button, kept inside the window; the list scrolls, the head stays.
  const box = anchor.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 16);
  el.style.width = width + "px";
  el.style.left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8)) + "px";
  // Opens toward the side with more room, so the agent list is never pushed
  // off the bottom of the window by a button low on the screen.
  const below = window.innerHeight - box.bottom - 14;
  const above = box.top - 14;
  if (below >= 360 || below >= above) {
    el.style.top = box.bottom + 6 + "px";
    el.style.maxHeight = Math.max(160, below) + "px";
  } else {
    el.style.bottom = window.innerHeight - box.top + 6 + "px";
    el.style.maxHeight = Math.max(160, above) + "px";
  }

  input.addEventListener("input", paint);
  list.addEventListener("click", (e) => {
    const row = e.target.closest("[data-i]");
    if (row && !row.disabled) run(Number(row.dataset.i));
  });
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    const r = rows();
    const at = r.indexOf(document.activeElement);
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      anchor.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (r.length) r[at < 0 ? 0 : Math.min(r.length - 1, at + 1)].focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (at <= 0) input.focus();
      else r[at - 1].focus();
    } else if (e.key === "Enter" && document.activeElement === input) {
      e.preventDefault();
      if (r.length) run(Number(r[0].dataset.i));
    } else if (e.key.length === 1 && document.activeElement !== input && !e.ctrlKey && !e.metaKey && !e.altKey) {
      input.focus(); // typing on a row goes to the search box
    }
  });

  const outside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const blur = () => close();
  function close() {
    if (current !== handle) return;
    current = null;
    document.removeEventListener("mousedown", outside, true);
    window.removeEventListener("blur", blur);
    window.removeEventListener("resize", blur);
    anchor.classList.remove("open");
    el.remove();
  }
  const handle = { el, anchor, close };
  current = handle;
  anchor.classList.add("open");
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("blur", blur);
  window.addEventListener("resize", blur);
  paint();
  input.focus();
}
