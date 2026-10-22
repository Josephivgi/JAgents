// The "+" menu on a tab strip. Modeled on Orca's new-tab menu (github.com/stablyai/orca,
// MIT, Copyright 2026 Lovecast Inc.): a search field, then New Terminal and plugin
// tabs, then one row per installed agent with its logo, then "Agent settings…".
// Typing turns the menu into a list of matches.
import { esc } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store } from "./store.js";
import { pluginKinds, pluginKindIcon } from "./plugins.js";
import { openSettings } from "./settings.js";

let current = null; // {el, close}

// Chat agents and terminal agents that are the same product share a row.
const CLI_FOR_CHAT = { "claude-code": "claude", cursor: "cursor-agent", devin: "devin-cli" };

function cliFor(chatId) {
  const id = CLI_FOR_CHAT[chatId] || chatId;
  return store.terminalAgents.find((t) => t.id === id && t.available) || null;
}

function shellLabel() {
  return navigator.userAgent.includes("Windows") ? "New Terminal: PowerShell" : "New Terminal";
}

const URLISH = /^(https?:\/\/\S+|localhost(:\d+)?(\/\S*)?|[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?)$/i;

// Everything the menu can do, as plain rows. `words` is what search matches.
function catalog(opts) {
  const create = [];
  const shell = store.terminalAgents.find((t) => t.id === "shell");
  if (shell && shell.available) create.push({ label: shellLabel(), verb: "New Terminal", icon: harnessIcon("shell", 16), words: "terminal shell powershell console new", choice: { kind: "terminal", id: "shell" } });
  for (const k of pluginKinds()) {
    const browser = k.key === "browser:tab";
    create.push({ label: browser ? "New Browser Tab" : "New " + k.title, verb: "New tab", icon: pluginKindIcon(k.key, 16), words: (browser ? "browser web page url " : "") + k.title + " " + k.description, choice: { kind: "plugin", key: k.key } });
  }

  const agents = [];
  const paired = new Set();
  const chats = store.acpAgents.slice().sort((a, b) => Number(b.available) - Number(a.available));
  for (const a of chats) {
    const cli = a.available ? cliFor(a.id) : null;
    if (cli) paired.add(cli.id);
    agents.push({
      label: a.name,
      icon: harnessIcon(a.id, 14),
      words: [a.id, a.name, a.command || "", "chat agent"].join(" "),
      title: a.available ? "Start a chat with " + a.name : a.install || "",
      disabled: !a.available,
      reason: a.available ? "" : "Not installed",
      choice: { kind: "chat", id: a.id },
      cli: cli ? { kind: "terminal", id: cli.id, name: cli.name } : null,
    });
  }
  const cliRows = store.terminalAgents
    .filter((t) => t.id !== "shell" && t.available && !paired.has(t.id))
    .map((t) => ({ label: t.name, icon: harnessIcon(t.id, 14), words: [t.id, t.name, "terminal cli agent"].join(" "), title: "Launch " + t.name + " in a new terminal", choice: { kind: "terminal", id: t.id }, cli: null }));
  if (cliRows.length && agents.length) cliRows[0].sepBefore = true;
  return { create, agents: agents.concat(cliRows), tabs: opts.tabs || [] };
}

function score(text, q) {
  const hay = text.toLowerCase();
  const parts = q.toLowerCase().split(/\s+/).filter(Boolean);
  let total = 0;
  for (const p of parts) {
    const i = hay.indexOf(p);
    if (i < 0) return -1;
    total += i === 0 || /\W/.test(hay[i - 1]) ? 2 : 1;
  }
  return total + (hay.startsWith(q.toLowerCase()) ? 3 : 0);
}

function results(cat, q) {
  const out = [];
  const ranked = (list, text) => list.map((x) => [score(text(x), q), x]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]).map(([, x]) => x);
  for (const t of ranked(cat.tabs, (t) => t.title + " " + (t.detail || "")).slice(0, 4)) out.push({ label: "Switch to tab", detail: t.title, icon: t.icon, choice: { kind: "switch", id: t.id } });
  for (const c of ranked(cat.create, (c) => c.label + " " + c.words)) out.push({ label: c.verb === "New Terminal" ? "New Terminal" : c.label, detail: c.verb === "New Terminal" ? c.label.replace(/^New Terminal:?\s*/, "") || "Shell" : "", icon: c.icon, choice: c.choice });
  const agents = ranked(cat.agents, (a) => a.label + " " + a.words).sort((a, b) => Number(Boolean(a.disabled)) - Number(Boolean(b.disabled)));
  for (const a of agents) {
    out.push({ label: a.choice.kind === "chat" ? "Start chat" : "Launch agent", detail: a.label + (a.reason ? " · " + a.reason : ""), icon: a.icon, choice: a.choice, disabled: a.disabled });
    if (a.cli) out.push({ label: "Launch agent", detail: a.cli.name, icon: a.icon, choice: { kind: "terminal", id: a.cli.id } });
  }
  const text = q.trim();
  if (URLISH.test(text) && cat.create.some((c) => c.choice.key === "browser:tab")) {
    const url = /^https?:\/\//i.test(text) ? text : (text.startsWith("localhost") ? "http://" : "https://") + text;
    out.unshift({ label: "Open URL", detail: url, icon: icon("globe", 14), choice: { kind: "plugin", key: "browser:tab", state: { url }, title: url } });
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
  const cat = catalog(o);
  const el = document.createElement("div");
  el.className = "ntp";
  el.setAttribute("role", "menu");
  el.innerHTML =
    '<form class="ntp-search" autocomplete="off"><input type="text" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="ntp-list" aria-label="Search" placeholder="Search open tabs, agents, URLs…"></form>' +
    '<div class="ntp-list" id="ntp-list"></div>';
  document.body.appendChild(el);
  const input = el.querySelector("input");
  const list = el.querySelector(".ntp-list");
  let rows = []; // what each [data-i] runs
  let hi = -1; // highlighted row, or -1 for the search field
  let sub = false; // the highlight is on the row's trailing terminal button

  function rowHtml(r, i, cls) {
    const trail = r.cli ? '<button type="button" class="ntp-cli" data-cli="' + i + '" tabindex="-1" title="' + esc("Launch " + r.cli.name + " in a new terminal") + '">' + harnessIcon("shell", 13) + "</button>" : "";
    return (
      '<div class="ntp-row ' + cls + (r.disabled ? " disabled" : "") + '" role="menuitem" data-i="' + i + '"' + (r.title ? ' title="' + esc(r.title) + '"' : "") + (r.disabled ? ' aria-disabled="true"' : "") + ">" +
      '<span class="ntp-ic">' + (r.icon || "") + "</span>" +
      '<span class="ntp-label">' + esc(r.label) + "</span>" +
      (r.reason ? '<span class="ntp-reason">' + esc(r.reason) + "</span>" : "") +
      (r.shortcut ? '<span class="ntp-key">' + esc(r.shortcut) + "</span>" : "") +
      trail +
      "</div>"
    );
  }

  function paint() {
    const q = input.value.trim();
    rows = [];
    let html = "";
    if (!q) {
      html += '<div class="ntp-sep"></div>';
      for (const c of cat.create) html += rowHtml(c, rows.push(c) - 1, "ntp-launch");
      html += '<div class="ntp-sep"></div>';
      if (!cat.agents.length) html += '<div class="ntp-row ntp-launch ntp-empty">No agents detected</div>';
      for (const a of cat.agents) {
        if (a.sepBefore) html += '<div class="ntp-sep"></div>';
        html += rowHtml(a, rows.push(a) - 1, "ntp-launch");
      }
      const settings = { label: "Agent settings…", icon: icon("gear", 16), choice: { kind: "settings" } };
      html += rowHtml(settings, rows.push(settings) - 1, "ntp-launch ntp-foot");
      hi = -1;
    } else {
      const found = results(cat, q);
      html += '<div class="ntp-results" role="listbox">';
      for (const r of found) {
        const i = rows.push(r) - 1;
        html +=
          '<div class="ntp-hit' + (r.disabled ? " disabled" : "") + '" role="option" data-i="' + i + '">' +
          '<span class="ntp-ic">' + (r.icon || "") + "</span>" +
          '<span class="ntp-hit-label">' + esc(r.label) + "</span>" +
          (r.detail ? '<span class="ntp-dot">·</span><span class="ntp-detail">' + esc(r.detail) + "</span>" : "") +
          "</div>";
      }
      if (!found.length) html += '<div class="ntp-status">No matches.</div>';
      html += "</div>";
      hi = rows.findIndex((r) => !r.disabled);
    }
    list.innerHTML = html;
    sub = false;
    mark();
  }

  function mark() {
    for (const n of list.querySelectorAll("[data-i]")) n.classList.toggle("hi", Number(n.dataset.i) === hi && !sub);
    for (const n of list.querySelectorAll("[data-cli]")) n.classList.toggle("hi", Number(n.dataset.cli) === hi && sub);
    const n = hi >= 0 && list.querySelector('[data-i="' + hi + '"]');
    if (n) n.scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", "");
  }

  function move(step) {
    const live = rows.map((r, i) => (r.disabled ? -1 : i)).filter((i) => i >= 0);
    if (!live.length) return;
    sub = false;
    const at = live.indexOf(hi);
    if (input.value.trim()) hi = live[(at + step + live.length) % live.length];
    else if (at < 0) hi = step > 0 ? live[0] : live[live.length - 1];
    else if (at + step < 0) hi = -1; // back up into the search field
    else hi = live[Math.min(live.length - 1, at + step)];
    mark();
  }

  function run(i, viaCli) {
    const r = rows[i];
    if (!r || r.disabled) return;
    close();
    const choice = viaCli && r.cli ? { kind: "terminal", id: r.cli.id } : r.choice;
    if (choice.kind === "settings") return openSettings("agents");
    if (o.onPick) o.onPick(choice);
  }

  // Position: 6px under the button, left edges aligned, kept inside the window.
  const box = anchor.getBoundingClientRect();
  const width = Math.min(288, window.innerWidth - 16);
  el.style.width = width + "px";
  el.style.left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8)) + "px";
  el.style.top = box.bottom + 6 + "px";
  el.style.maxHeight = Math.max(160, window.innerHeight - box.bottom - 14) + "px";

  input.addEventListener("input", paint);
  el.querySelector("form").addEventListener("submit", (e) => e.preventDefault());
  el.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      anchor.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      move(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Home" || e.key === "End") {
      if (input.value || hi < 0) return;
      e.preventDefault();
      hi = -2;
      move(e.key === "Home" ? 1 : -1);
    } else if (e.key === "ArrowRight" && hi >= 0 && rows[hi].cli && !input.value) {
      e.preventDefault();
      sub = true;
      mark();
    } else if (e.key === "ArrowLeft" && sub) {
      e.preventDefault();
      sub = false;
      mark();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (hi >= 0) run(hi, sub);
      else if (!input.value.trim() && rows.length) run(rows.findIndex((r) => !r.disabled));
    }
  });
  list.addEventListener("mousemove", (e) => {
    const cli = e.target.closest("[data-cli]");
    const row = e.target.closest("[data-i]");
    const i = row ? Number(row.dataset.i) : -1;
    const s = Boolean(cli);
    if ((i !== hi || s !== sub) && row && !rows[i].disabled) {
      hi = i;
      sub = s;
      mark();
    }
  });
  list.addEventListener("click", (e) => {
    const cli = e.target.closest("[data-cli]");
    if (cli) return run(Number(cli.dataset.cli), true);
    const row = e.target.closest("[data-i]");
    if (row) run(Number(row.dataset.i), false);
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
    el.classList.add("closing");
    setTimeout(() => el.remove(), 150);
  }
  const handle = { el, anchor, close };
  current = handle;
  anchor.classList.add("open");
  document.addEventListener("mousedown", outside, true);
  window.addEventListener("blur", blur);
  window.addEventListener("resize", blur);
  paint();
  requestAnimationFrame(() => input.focus());
}
