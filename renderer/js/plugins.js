// Plugins in the window: loads each enabled plugin's style.css and renderer.js,
// hands renderer.js the jagents API (top bar buttons, sidebar sections, pane
// types, CSS, events, storage, its main.cjs), and removes everything a plugin
// added when it reloads or turns off. Also the Plugins panel, where the user
// sees what agents changed and turns plugins on, off, back, or away.

import { esc, toast, errorText } from "./util.js";
import { icon } from "./icons.js";
import { store, fire, on } from "./store.js";
import { modal } from "./dialogs.js";

const loaded = new Map(); // id -> {stamp, cleanups: [fn]}
const kinds = new Map(); // "plugin:kind" -> {pluginId, def, version}
const sections = new Map(); // id -> [{title, render, el}]
let kindVersion = 0;
let syncing = Promise.resolve();

store.plugins = { safeMode: false, dir: "", plugins: [] };

function errorStack(error) {
  return String((error && (error.stack || error.message)) || error || "Unknown error");
}

function report(id, error) {
  window.jagents.plugins.report(id, { error: error ? errorStack(error) : "" }).catch(() => {});
  if (error) console.error("[plugin " + id + "]", error);
}

// Plugin callbacks run guarded: a throw is shown in the Plugins panel, not lost.
function guard(id, fn) {
  return (...args) => {
    try {
      const out = fn(...args);
      if (out && typeof out.catch === "function") out.catch((e) => report(id, e));
      return out;
    } catch (error) {
      report(id, error);
      return undefined;
    }
  };
}

function iconHtml(name, size) {
  const n = String(name || "puzzle");
  return n.trim().startsWith("<svg") ? n : icon(n, size);
}

function paintSections() {
  const box = document.querySelector("[data-plugin-side]");
  if (!box) return;
  const all = Array.from(sections.values()).flat();
  box.hidden = all.length === 0;
  for (const s of all) {
    if (!s.el.isConnected) box.appendChild(s.el);
    s.el.querySelector(".nav-label").textContent = s.title;
    const body = s.el.querySelector(".plugin-section-body");
    body.innerHTML = "";
    s.render(body);
  }
}

function apiFor(p, storage, cleanups) {
  const id = p.id;
  const later = (fn) => cleanups.push(fn);
  const base = "plugins/" + id + "@" + p.stamp + "/";
  const api = {
    id,
    url: (rel) => base + String(rel || "").replace(/^\/+/, ""),
    icon: (name, size) => iconHtml(name, size || 16),
    esc,
    store,
    app: window.jagents,
    toast: (text) => toast(String(text)),
    modal: (html, opts) => {
      const m = modal(String(html || ""), { wide: Boolean(opts && opts.wide) });
      if (opts && opts.width) m.el.style.width = Number(opts.width) + "px";
      later(m.close);
      return m;
    },
    css(text) {
      const el = document.createElement("style");
      el.dataset.plugin = id;
      el.textContent = String(text || "");
      document.head.appendChild(el);
      later(() => el.remove());
      return { remove: () => el.remove() };
    },
    on(type, fn) {
      const off = on("app:" + type, guard(id, fn));
      later(off);
      return off;
    },
    onMessage(channel, fn) {
      const g = guard(id, fn);
      const off = on("app:plugin-message", (m) => m && m.id === id && m.channel === channel && g(m.payload));
      later(off);
      return off;
    },
    invoke: (channel, payload) => window.jagents.plugins.invoke(id, String(channel), payload),
    dispose: (fn) => later(fn),
    storage: {
      get: (key, fallback) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : fallback),
      set(key, value) {
        if (value === undefined || value === null) delete storage[key];
        else storage[key] = value;
        return window.jagents.plugins.storageSet(id, String(key), value === undefined ? null : value);
      },
    },
    topbar: {
      button(opts) {
        const o = opts || {};
        const host = document.querySelector("[data-plugin-top]");
        const b = document.createElement("button");
        b.className = o.label ? "btn sm ghost plugin-top-btn" : "icon-btn plugin-top-btn";
        b.dataset.plugin = id;
        b.title = String(o.title || o.label || p.name);
        b.setAttribute("aria-label", b.title);
        b.innerHTML = iconHtml(o.icon, 16) + (o.label ? "<span>" + esc(o.label) + "</span>" : "");
        if (o.onClick) b.addEventListener("click", guard(id, (e) => o.onClick(e, b)));
        if (host) host.appendChild(b);
        const remove = () => b.remove();
        later(remove);
        return { el: b, remove };
      },
    },
    sidebar: {
      section(opts) {
        const o = opts || {};
        const el = document.createElement("div");
        el.className = "plugin-section";
        el.dataset.plugin = id;
        el.innerHTML = '<p class="nav-label"></p><div class="plugin-section-body"></div>';
        const entry = { title: String(o.title || p.name), render: guard(id, o.render || (() => {})), el };
        const list = sections.get(id) || [];
        list.push(entry);
        sections.set(id, list);
        paintSections();
        const remove = () => {
          el.remove();
          sections.set(id, (sections.get(id) || []).filter((x) => x !== entry));
          paintSections();
        };
        later(remove);
        return { el, remove, refresh: paintSections };
      },
      refresh: paintSections,
    },
    panes: {
      register(kind, def) {
        const k = String(kind || "");
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(k)) throw new Error("Pane kinds are lowercase letters, digits and dashes: " + JSON.stringify(kind));
        if (!def || typeof def.mount !== "function") throw new Error("panes.register needs a mount(el, pane) function.");
        const key = id + ":" + k;
        kinds.set(key, { pluginId: id, def, version: ++kindVersion });
        fire("plugin-kinds");
        later(() => {
          if (kinds.get(key) && kinds.get(key).def === def) {
            kinds.delete(key);
            fire("plugin-kinds");
          }
        });
      },
      open: (kind, opts) => openPluginPane(id + ":" + String(kind), opts),
      list: () => store.panes.filter((x) => x.kind === "plugin" && x.pluginKind.startsWith(id + ":")),
    },
  };
  return api;
}

function unload(id) {
  const entry = loaded.get(id);
  if (!entry) return;
  loaded.delete(id);
  for (const fn of entry.cleanups.reverse()) {
    try {
      fn();
    } catch (error) {
      console.error("[plugin " + id + "] cleanup", error);
    }
  }
}

async function load(p) {
  const cleanups = [];
  loaded.set(p.id, { stamp: p.stamp, cleanups });
  const base = "plugins/" + p.id + "@" + p.stamp + "/";
  try {
    if (p.hasCss) {
      const res = await fetch(base + "style.css");
      if (!res.ok) throw new Error("style.css could not be read (" + res.status + ")");
      const el = document.createElement("style");
      el.dataset.plugin = p.id;
      el.textContent = await res.text();
      document.head.appendChild(el);
      cleanups.push(() => el.remove());
    }
    if (p.hasRenderer) {
      const storage = await window.jagents.plugins.storageGet(p.id);
      const mod = await import("./../" + base + "renderer.js");
      if (typeof mod.activate !== "function") throw new Error("renderer.js must export function activate(jagents).");
      const out = await mod.activate(apiFor(p, storage, cleanups));
      if (typeof out === "function") cleanups.push(out);
      if (typeof mod.deactivate === "function") cleanups.push(() => mod.deactivate());
    }
    report(p.id, null);
  } catch (error) {
    report(p.id, error);
  }
}

// Bring the window in line with the plugin list: load new or changed
// plugins, unload ones that were turned off or removed.
function sync(force) {
  syncing = syncing.then(async () => {
    const state = await window.jagents.plugins.list();
    store.plugins = state;
    const want = new Map(state.plugins.filter((p) => !state.safeMode && p.enabled && (p.hasRenderer || p.hasCss)).map((p) => [p.id, p]));
    for (const id of Array.from(loaded.keys())) {
      const p = want.get(id);
      if (!p || p.stamp !== loaded.get(id).stamp || (force && force.has(id))) unload(id);
    }
    for (const p of want.values()) if (!loaded.has(p.id)) await load(p);
    fire("plugins", store.plugins);
  });
  return syncing;
}

// The Plugins card at the bottom of the sidebar: how many are on, and any trouble.
function paintCard() {
  const el = document.querySelector("[data-plugin-summary]");
  if (!el) return;
  const st = store.plugins;
  const on = st.plugins.filter((p) => p.enabled).length;
  const broken = st.plugins.filter((p) => p.enabled && (p.errors.main || p.errors.renderer || p.errors.mcp)).length;
  el.textContent = st.safeMode ? "Safe mode: all off" : !st.plugins.length ? "None yet" : on + " of " + st.plugins.length + " on" + (broken ? " · " + broken + " with errors" : "");
  el.classList.toggle("warn-text", Boolean(st.safeMode || broken));
}

export function initPlugins() {
  on("plugins", paintCard);
  on("app:plugins-changed", (ev) => sync(ev && ev.id && ev.id !== "*" ? new Set([ev.id]) : null));
  on("app:plugins-state", (state) => {
    store.plugins = state;
    fire("plugins", state);
  });
  return sync();
}

// ---- plugin panes in Code mode ----------------------------------------

export function pluginKinds() {
  return Array.from(kinds.entries()).map(([key, k]) => ({ key, title: String(k.def.title || key), icon: k.def.icon, description: String(k.def.description || ""), pluginId: k.pluginId }));
}

export function pluginKindIcon(key, size) {
  const k = kinds.get(key);
  return iconHtml(k && k.def.icon, size);
}

export async function openPluginPane(key, opts) {
  const k = kinds.get(key);
  const o = opts || {};
  try {
    return await window.jagents.panes.addPlugin({ kind: key, title: o.title || (k && k.def.title) || key, state: o.state || {} });
  } catch (error) {
    toast(errorText(error));
    return null;
  }
}

export class PluginPaneView {
  constructor(el, pane) {
    this.el = el;
    this.pane = pane;
    this.version = -1;
    this.cleanup = null;
    this.render();
    this.off = on("plugin-kinds", () => this.render());
  }

  render() {
    const k = kinds.get(this.pane.pluginKind);
    const version = k ? k.version : 0;
    if (version === this.version) return;
    this.unmount();
    this.version = version;
    if (!k) {
      const pluginId = String(this.pane.pluginKind || "").split(":")[0];
      this.el.innerHTML = '<div class="plugin-missing">' + icon("puzzle", 22) + "<p>The <b>" + esc(pluginId) + "</b> plugin that draws this pane is off or not installed.</p>" + '<button class="btn sm secondary" data-open-plugins>Open Plugins</button></div>';
      return;
    }
    this.el.innerHTML = "";
    const host = document.createElement("div");
    host.className = "plugin-pane-body";
    this.el.appendChild(host);
    const view = this;
    const api = {
      id: this.pane.id,
      get state() {
        return view.pane.state || {};
      },
      setState(patch) {
        view.pane.state = Object.assign({}, view.pane.state, patch);
        window.jagents.panes.updatePlugin(view.pane.id, { state: view.pane.state }).catch(() => {});
      },
      setTitle(text) {
        window.jagents.panes.updatePlugin(view.pane.id, { title: String(text || "") }).catch(() => {});
      },
      visible: () => host.isConnected && !host.closest(".parked,[hidden]") && host.offsetWidth > 0 && host.offsetHeight > 0,
      el: host,
    };
    try {
      const out = k.def.mount(host, api);
      if (typeof out === "function") this.cleanup = out;
    } catch (error) {
      report(k.pluginId, error);
      host.innerHTML = '<div class="plugin-missing"><p>This pane failed to draw. The error is in the Plugins panel.</p></div>';
    }
  }

  unmount() {
    if (this.cleanup) {
      try {
        this.cleanup();
      } catch (error) {
        console.error(error);
      }
    }
    this.cleanup = null;
  }

  focus() {
    const f = this.el.querySelector("input, textarea, [tabindex]");
    if (f) f.focus();
  }

  destroy() {
    this.unmount();
    this.off();
  }
}

// ---- the Plugins panel -------------------------------------------------

function ago(ms) {
  if (!ms) return "";
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(ms).toLocaleDateString();
}

function pluginRow(p, safe) {
  const chips = [];
  if (p.hasRenderer || p.hasCss) chips.push('<span class="chip">' + icon("grid", 11) + "UI</span>");
  for (const s of p.appServers) chips.push('<span class="chip hub" title="Runs inside JAgents: ' + esc(s.tools.join(", ")) + '">' + icon("hub", 11) + esc(s.name) + " · " + s.tools.length + " tools</span>");
  for (const s of p.mcpServers) chips.push('<span class="chip hub" title="Outside MCP server every agent gets">' + icon("hub", 11) + esc(s) + "</span>");
  if (p.disableTools.length) chips.push('<span class="chip warn" title="' + esc(p.disableTools.join(", ")) + '">Blocks ' + p.disableTools.length + " tool" + (p.disableTools.length === 1 ? "" : "s") + "</span>");
  const errs = [p.errors.main && "main.cjs: " + p.errors.main, p.errors.renderer && "renderer: " + p.errors.renderer, p.errors.mcp && "MCP: " + p.errors.mcp].filter(Boolean);
  return (
    '<div class="plugin-row' + (p.enabled && !safe ? "" : " off") + '" data-plugin-row="' + esc(p.id) + '">' +
    '<div class="plugin-ic">' + icon("puzzle", 18) + "</div>" +
    '<div class="grow"><div class="plugin-name">' + esc(p.name) + (p.version ? ' <span class="muted small">v' + esc(p.version) + "</span>" : "") + "</div>" +
    (p.description ? '<div class="muted small">' + esc(p.description) + "</div>" : "") +
    '<div class="plugin-meta muted small"><span class="mono">' + esc(p.id) + "</span>" + (p.author ? " · changed by <b>" + esc(p.author) + "</b> " + esc(ago(p.updatedAt)) : "") + "</div>" +
    (chips.length ? '<div class="tool-chips">' + chips.join("") + "</div>" : "") +
    (errs.length ? '<pre class="plugin-error">' + esc(errs.join("\n")) + "</pre>" : "") +
    "</div>" +
    '<div class="plugin-actions">' +
    '<button class="switch' + (p.enabled ? " on" : "") + '" role="switch" aria-checked="' + p.enabled + '" data-p-toggle="' + esc(p.id) + '" aria-label="Turn ' + esc(p.name) + ' on or off"' + (safe ? " disabled" : "") + "></button>" +
    '<div class="plugin-btns">' +
    '<button class="icon-btn" data-p-code="' + esc(p.id) + '" title="View code">' + icon("code", 15) + "</button>" +
    '<button class="icon-btn" data-p-undo="' + esc(p.id) + '" title="' + (p.undoable ? "Undo the last change (" + p.undoable + " saved)" : "No earlier version") + '"' + (p.undoable ? "" : " disabled") + ">" + icon("undo", 15) + "</button>" +
    '<button class="icon-btn" data-p-folder="' + esc(p.id) + '" title="Open folder">' + icon("folder", 15) + "</button>" +
    '<button class="icon-btn" data-p-remove="' + esc(p.id) + '" title="Remove">' + icon("trash", 15) + "</button>" +
    "</div></div></div>"
  );
}

function panelMarkup() {
  const st = store.plugins;
  return (
    '<header class="modal-head">' + icon("puzzle", 18) + "<h2>Plugins</h2>" + (st.safeMode ? '<span class="pill warn">Safe mode</span>' : "") +
    '<span class="spacer"></span><button class="btn sm secondary" data-p-new>' + icon("plus", 14) + "New plugin</button>" +
    '<button class="btn sm ghost" data-p-folder="">' + icon("folder", 14) + "Folder</button>" +
    '<button class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></header>" +
    '<div class="modal-body">' +
    (st.safeMode ? '<div class="safe-banner">Safe mode is on, so every plugin is off. <button class="btn sm primary" data-p-safe-off>Turn plugins back on</button></div>' : "") +
    '<div class="plugin-list">' + (st.plugins.length ? st.plugins.map((p) => pluginRow(p, st.safeMode)).join("") : '<p class="muted small">No plugins yet.</p>') + "</div>" +
    '<p class="muted small">Plugin folder: <span class="mono">' + esc(st.dir) + "</span>. MCP changes reach agents when they start, so restart open terminals after turning a plugin with MCP servers on or off.</p>" +
    "</div>"
  );
}

async function showCode(id) {
  const p = await window.jagents.plugins.read(id);
  const files = Object.keys(p.content);
  const m = modal(
    '<header class="modal-head">' + icon("code", 18) + "<h2>" + esc(p.name) + '</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></header>" +
      '<div class="modal-body"><div class="seg file-tabs">' + files.map((f, i) => '<button data-file="' + esc(f) + '"' + (i ? "" : ' class="on"') + ">" + esc(f) + "</button>").join("") + "</div>" +
      '<pre class="code-view" data-code></pre><p class="muted small">Edit the files in the plugin folder with any editor; JAgents reloads on save.</p></div>',
    { wide: true },
  );
  const show = (f) => {
    m.el.querySelector("[data-code]").textContent = p.content[f];
    for (const b of m.el.querySelectorAll("[data-file]")) b.classList.toggle("on", b.dataset.file === f);
  };
  if (files.length) show(files[0]);
  m.el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-file]");
    if (b) show(b.dataset.file);
  });
}

export async function openPluginsPanel() {
  store.plugins = await window.jagents.plugins.list();
  const m = modal(panelMarkup(), { wide: true });
  m.el.classList.add("plugins-panel");
  const repaint = () => {
    if (!m.el.isConnected) return;
    m.el.innerHTML = panelMarkup();
  };
  const offState = on("plugins", repaint);
  const watcher = new MutationObserver(() => {
    if (!m.el.isConnected) {
      offState();
      watcher.disconnect();
    }
  });
  watcher.observe(document.body, { childList: true });
  const run = async (btn, fn) => {
    if (btn) btn.disabled = true;
    try {
      await fn();
    } catch (error) {
      toast(errorText(error));
    }
    if (btn && btn.isConnected) btn.disabled = false;
  };
  m.el.addEventListener("click", (e) => {
    const t = e.target;
    const b = (sel) => t.closest(sel);
    if (b("[data-p-toggle]")) {
      const id = b("[data-p-toggle]").dataset.pToggle;
      const p = store.plugins.plugins.find((x) => x.id === id);
      return run(b("[data-p-toggle]"), async () => {
        await window.jagents.plugins.setEnabled(id, !p.enabled);
        if (p.mcpServers.length || p.appServers.length || p.disableTools.length) toast("Restart open terminals so agents get the change.");
      });
    }
    if (b("[data-p-code]")) return run(null, () => showCode(b("[data-p-code]").dataset.pCode));
    if (b("[data-p-undo]")) return run(b("[data-p-undo]"), async () => {
      await window.jagents.plugins.undo(b("[data-p-undo]").dataset.pUndo);
      toast("Put back the previous version.");
    });
    if (b("[data-p-folder]")) return run(null, () => window.jagents.plugins.openFolder(b("[data-p-folder]").dataset.pFolder));
    if (b("[data-p-remove]")) return run(b("[data-p-remove]"), () => window.jagents.plugins.remove(b("[data-p-remove]").dataset.pRemove));
    if (b("[data-p-new]")) return run(b("[data-p-new]"), async () => {
      const p = await window.jagents.plugins.scaffold();
      toast("Created " + p.id + ". Edit it in its folder; JAgents reloads on save.");
      window.jagents.plugins.openFolder(p.id);
    });
    if (b("[data-p-safe-off]")) return run(b("[data-p-safe-off]"), () => window.jagents.plugins.setSafeMode(false));
  });
}

export function openPluginsFromPane(e) {
  if (e.target.closest("[data-open-plugins]")) {
    openPluginsPanel();
    return true;
  }
  return false;
}
