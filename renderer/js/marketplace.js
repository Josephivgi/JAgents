// Agent marketplace: every agent in the official ACP Registry plus the
// built-ins, searchable, with Install, Update, and Uninstall run in the main
// process (lib/agent-install.js), and custom ACP commands. Installed agents
// show up in the composer's Agent picker, the + menu, and spawn_subagent.

import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { on, refreshAgents } from "./store.js";
import { modal } from "./dialogs.js";

const state = { list: null, installs: {}, filter: "all", query: "", loading: false };
let open = null;

const FILTERS = [
  ["all", "All"],
  ["installed", "Installed"],
  ["updates", "Updates"],
  ["available", "Not installed"],
];

function ago(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  if (s < 129600) return Math.round(s / 3600) + " h ago";
  return new Date(ms).toLocaleDateString();
}

function matches(a) {
  const needle = state.query.trim().toLowerCase();
  if (needle && !(a.name + " " + a.id + " " + a.description + " " + a.authors).toLowerCase().includes(needle)) return false;
  if (state.filter === "installed") return a.installed;
  if (state.filter === "updates") return a.update;
  if (state.filter === "available") return !a.installed;
  return true;
}

function logoMarkup(a) {
  return a.icon ? '<img src="' + esc(a.icon) + '" alt="" width="22" height="22">' : harnessIcon(a.id, 22);
}

function actionsMarkup(a) {
  const job = state.installs[a.id];
  if (job && job.state === "running") return '<button class="btn sm secondary" disabled><span class="spinner"></span>Installing</button>';
  const out = [];
  if (a.update) out.push('<button class="btn sm primary" data-m-install="' + esc(a.id) + '">' + icon("update", 14) + "Update</button>");
  if (!a.installed && a.canInstall) out.push('<button class="btn sm primary" data-m-install="' + esc(a.id) + '">' + icon("update", 14) + "Install</button>");
  if (!a.installed && !a.canInstall) out.push('<span class="muted small">' + esc(a.how || "Not available here") + "</span>");
  if (a.installed && !a.update) out.push('<span class="pill ok">' + icon("check", 12) + "Installed</span>");
  if (a.managed) out.push('<button class="icon-btn" data-m-remove="' + esc(a.id) + '" title="Uninstall" aria-label="Uninstall ' + esc(a.name) + '">' + icon("trash", 15) + "</button>");
  return out.join("");
}

function cardMarkup(a) {
  const job = state.installs[a.id];
  const meta = [a.version ? "v" + a.version : "", a.authors, a.license].filter(Boolean).join(" · ");
  const links =
    (a.website ? '<button class="icon-btn" data-m-url="' + esc(a.website) + '" title="Website" aria-label="Website">' + icon("globe", 14) + "</button>" : "") +
    (a.repository && a.repository !== a.website ? '<button class="icon-btn" data-m-url="' + esc(a.repository) + '" title="Source" aria-label="Source">' + icon("code", 14) + "</button>" : "");
  const note =
    job && job.state === "running" ? '<div class="market-log mono" title="' + esc(job.line) + '">' + esc(job.line) + "</div>"
      : job && job.state === "failed" ? '<div class="market-fail">' + esc(job.error) + "</div>"
        : a.update ? '<div class="muted small">Installed v' + esc(a.installedVersion) + ", v" + esc(a.version) + " is out.</div>"
          : "";
  return (
    '<article class="market-card' + (a.installed ? " is-installed" : "") + '">' +
    '<div class="market-card-head"><div class="market-logo">' + logoMarkup(a) + "</div>" +
    '<div class="market-card-title"><h3>' + esc(a.name) + "</h3>" + (meta ? '<span class="muted small" title="' + esc(meta) + '">' + esc(meta) + "</span>" : "") + "</div>" +
    (a.builtIn ? '<span class="chip">Built in</span>' : "") + "</div>" +
    '<p class="market-desc">' + esc(a.description) + "</p>" + note +
    '<div class="market-card-foot"><div class="market-links">' + links + "</div>" + actionsMarkup(a) + "</div></article>"
  );
}

function customMarkup(c) {
  return (
    '<div class="market-custom-row">' + harnessIcon(c.id, 16) + '<span class="grow"><b>' + esc(c.name) + '</b> <span class="mono muted small">' + esc(c.commandLabel) + "</span></span>" +
    (c.available ? "" : '<span class="pill warn">Command not found</span>') +
    '<button class="icon-btn" data-m-remove="' + esc(c.id) + '" title="Remove" aria-label="Remove ' + esc(c.name) + '">' + icon("trash", 15) + "</button></div>"
  );
}

function bodyMarkup() {
  const l = state.list;
  if (!l) return '<p class="muted small market-empty"><span class="spinner"></span> Loading the ACP Registry…</p>';
  const shown = l.agents.filter(matches);
  return (
    (l.error ? '<div class="market-warn">' + esc(l.error) + "</div>" : "") +
    (shown.length ? '<div class="market-grid">' + shown.map(cardMarkup).join("") + "</div>" : '<p class="muted small market-empty">No agents match.</p>')
  );
}

function countsMarkup() {
  const l = state.list;
  if (!l) return "";
  const n = (fn) => l.agents.filter(fn).length;
  return { all: l.agents.length, installed: n((a) => a.installed), updates: n((a) => a.update), available: n((a) => !a.installed) };
}

function filtersMarkup() {
  const c = countsMarkup() || {};
  return FILTERS.map(([k, label]) => '<button data-m-filter="' + k + '"' + (state.filter === k ? ' class="on"' : "") + ">" + label + (c[k] != null ? ' <span class="market-count">' + c[k] + "</span>" : "") + "</button>").join("");
}

function panelMarkup() {
  return (
    '<header class="modal-head">' + icon("store", 18) + "<h2>Agent marketplace</h2>" +
    '<span class="muted small" data-m-source></span><span class="spacer"></span>' +
    '<button class="btn sm ghost" data-m-refresh title="Check the registry for new agents and versions">' + icon("restart", 14) + "Refresh</button>" +
    '<button class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></header>" +
    '<div class="market-tools"><div class="side-search market-search">' + icon("search", 14) + '<input type="text" data-m-search placeholder="Search agents, authors, descriptions" aria-label="Search agents" value="' + esc(state.query) + '"></div>' +
    '<div class="seg" data-m-filters>' + filtersMarkup() + "</div></div>" +
    '<div class="modal-body market-body"><div data-m-list>' + bodyMarkup() + "</div>" +
    '<details class="market-custom"><summary>' + icon("plus", 14) + "Add a custom ACP agent</summary>" +
    '<p class="muted small">Any command that speaks the Agent Client Protocol over stdio.</p>' +
    '<div data-m-customs></div>' +
    '<div class="market-form"><input data-m-name placeholder="Name" maxlength="60" aria-label="Agent name">' +
    '<input data-m-command placeholder="Command, like my-agent" aria-label="Command">' +
    '<input data-m-args placeholder="Arguments, like --acp" aria-label="Arguments">' +
    '<button class="btn sm primary" data-m-custom>Add</button></div></details></div>'
  );
}

function paint() {
  if (!open || !open.el.isConnected) return;
  const el = open.el;
  const list = el.querySelector("[data-m-list]");
  const scroll = el.querySelector(".market-body").scrollTop;
  list.innerHTML = bodyMarkup();
  el.querySelector(".market-body").scrollTop = scroll;
  el.querySelector("[data-m-filters]").innerHTML = filtersMarkup();
  const src = el.querySelector("[data-m-source]");
  src.textContent = state.list ? state.list.agents.length + " agents · ACP Registry, " + ago(state.list.fetchedAt) : "";
  const customs = el.querySelector("[data-m-customs]");
  customs.innerHTML = state.list && state.list.custom.length ? state.list.custom.map(customMarkup).join("") : "";
}

async function load(refresh) {
  state.loading = true;
  try {
    const [list, installs] = await Promise.all([window.jagents.marketplace.list({ refresh: Boolean(refresh) }), window.jagents.marketplace.installs()]);
    state.list = list;
    state.installs = Object.assign({}, installs, Object.fromEntries(Object.entries(state.installs).filter(([, j]) => j.state === "running")));
  } finally {
    state.loading = false;
  }
}

async function reload(refresh) {
  try {
    await load(refresh);
  } catch (error) {
    toast(errorText(error));
  }
  paint();
}

// Install progress arrives as app events whether or not the panel is open.
on("app:agent-install", (job) => {
  state.installs[job.id] = job;
  if (job.state === "running") return paint();
  toast(job.state === "done" ? job.line + " Pick it in any chat's Agent menu." : (job.name || "The agent") + " did not install: " + job.error);
  reload(false);
});
on("app:agents-changed", () => {
  refreshAgents().catch(() => {});
  if (open && open.el.isConnected) reload(false);
});

export async function openMarketplace() {
  if (open && open.el.isConnected) return;
  open = modal(panelMarkup(), { wide: true, onClose: () => (open = null) });
  const m = open;
  m.el.classList.add("market-panel");
  const run = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (error) {
      toast(errorText(error));
    }
    if (btn && btn.isConnected) btn.disabled = false;
  };
  m.el.addEventListener("input", (e) => {
    if (e.target.matches("[data-m-search]")) {
      state.query = e.target.value;
      paint();
    }
  });
  m.el.addEventListener("click", (e) => {
    const b = (sel) => e.target.closest(sel);
    if (b("[data-m-filter]")) {
      state.filter = b("[data-m-filter]").dataset.mFilter;
      return paint();
    }
    if (b("[data-m-refresh]")) return run(b("[data-m-refresh]"), () => reload(true));
    if (b("[data-m-install]")) {
      const id = b("[data-m-install]").dataset.mInstall;
      state.installs[id] = { id, state: "running", line: "Starting…" };
      paint();
      return window.jagents.marketplace.install(id).catch((error) => {
        state.installs[id] = { id, state: "failed", error: errorText(error), line: "" };
        paint();
      });
    }
    if (b("[data-m-url]")) return run(null, () => window.jagents.openUrl(b("[data-m-url]").dataset.mUrl));
    if (b("[data-m-remove]")) return run(b("[data-m-remove]"), () => window.jagents.marketplace.remove(b("[data-m-remove]").dataset.mRemove));
    if (b("[data-m-custom]")) return run(b("[data-m-custom]"), async () => {
      const val = (k) => m.el.querySelector("[data-m-" + k + "]").value;
      const added = await window.jagents.marketplace.add({ name: val("name"), command: val("command"), args: val("args") });
      for (const k of ["name", "command", "args"]) m.el.querySelector("[data-m-" + k + "]").value = "";
      toast(added.existing ? added.name + " was already added." : added.name + " is in the Agent picker.");
    });
  });
  setTimeout(() => m.el.querySelector("[data-m-search]").focus(), 30);
  await reload(false);
}
