"use strict";

// Built-in browser: each browser pane is an Electron WebContentsView laid over
// the pane's body (the renderer reports where). The "browser" MCP server lets
// every agent open pages, read them, take screenshots, click and type in the
// same browser the user sees.

const { WebContentsView, shell } = require("electron");

const HOME = "https://duckduckgo.com/";
const LOAD_MS = 20000;

function normalizeUrl(input) {
  const v = String(input || "").trim();
  if (!v) return HOME;
  if (/^(https?:|about:blank$)/i.test(v)) return v;
  if (/^localhost(:\d+)?(\/|$)/i.test(v) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(v)) return "http://" + v;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(v)) return "https://" + v;
  return "https://duckduckgo.com/?q=" + encodeURIComponent(v);
}

exports.activate = (ctx) => {
  const tabs = new Map(); // pane id -> {view, visible}
  const attachWaiters = [];
  let active = "";

  function state(id) {
    const t = tabs.get(id);
    if (!t) return null;
    const wc = t.view.webContents;
    return { pane: id, url: wc.getURL(), title: wc.getTitle(), loading: wc.isLoading(), canBack: wc.navigationHistory.canGoBack(), canForward: wc.navigationHistory.canGoForward() };
  }

  function push(id) {
    const s = state(id);
    if (s) ctx.send("state", s);
  }

  function ensure(id, url) {
    const existing = tabs.get(id);
    if (existing) return existing;
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: "persist:relay-browser" } });
    view.setBackgroundColor("#ffffff");
    view.setVisible(false);
    const t = { id, view, visible: false };
    tabs.set(id, t);
    const wc = view.webContents;
    // Pop-ups open in the same pane.
    wc.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:/i.test(next)) wc.loadURL(next).catch(() => {});
      return { action: "deny" };
    });
    for (const ev of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"]) wc.on(ev, () => push(id));
    wc.on("did-fail-load", (_e, code, desc, failedUrl, isMain) => {
      if (isMain && code !== -3) ctx.send("state", Object.assign(state(id) || {}, { pane: id, error: desc + " (" + failedUrl + ")" }));
    });
    wc.on("focus", () => (active = id));
    const win = ctx.window();
    if (win && !win.isDestroyed()) win.contentView.addChildView(view);
    wc.loadURL(normalizeUrl(url)).catch(() => {});
    if (!active) active = id;
    while (attachWaiters.length) attachWaiters.shift()(id);
    return t;
  }

  function destroy(id) {
    const t = tabs.get(id);
    if (!t) return;
    tabs.delete(id);
    const win = ctx.window();
    try {
      if (win && !win.isDestroyed()) win.contentView.removeChildView(t.view);
    } catch {
      /* window closing */
    }
    if (!t.view.webContents.isDestroyed()) t.view.webContents.close();
    if (active === id) active = tabs.keys().next().value || "";
  }

  // A reloaded window draws its panes again and reports new bounds; until
  // then no view may cover it.
  const win = ctx.window();
  const hideAll = () => {
    for (const t of tabs.values()) t.view.setVisible(false);
  };
  if (win) {
    win.webContents.on("did-start-navigation", hideAll);
    ctx.dispose(() => {
      if (!win.isDestroyed()) win.webContents.removeListener("did-start-navigation", hideAll);
    });
  }
  ctx.dispose(() => {
    for (const id of Array.from(tabs.keys())) destroy(id);
  });

  ctx.handle("attach", ({ pane, url }) => {
    ensure(String(pane), url);
    return state(String(pane));
  });
  ctx.handle("bounds", ({ pane, rect, visible }) => {
    const t = tabs.get(String(pane));
    if (!t) return false;
    const show = Boolean(visible && rect && rect.width > 2 && rect.height > 2);
    if (show) t.view.setBounds({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    if (show !== t.visible) t.view.setVisible(show);
    t.visible = show;
    return true;
  });
  ctx.handle("navigate", ({ pane, url }) => {
    const t = ensure(String(pane));
    active = String(pane);
    t.view.webContents.loadURL(normalizeUrl(url)).catch(() => {});
    return true;
  });
  ctx.handle("nav", ({ pane, action }) => {
    const t = tabs.get(String(pane));
    if (!t) return false;
    const wc = t.view.webContents;
    active = String(pane);
    if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === "reload") wc.reload();
    else if (action === "stop") wc.stop();
    else if (action === "external" && /^https?:/i.test(wc.getURL())) shell.openExternal(wc.getURL());
    return true;
  });
  // Panes that still exist; views for closed panes go away.
  ctx.handle("sync", ({ panes }) => {
    const keep = new Set((panes || []).map(String));
    for (const id of Array.from(tabs.keys())) if (!keep.has(id)) destroy(id);
    return true;
  });

  // ---- the browser MCP server ----------------------------------------

  function settle(wc, ms) {
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        clearTimeout(timer);
        wc.removeListener("did-stop-loading", done);
        setTimeout(resolve, 200);
      };
      timer = setTimeout(done, ms || LOAD_MS);
      if (!wc.isLoading()) return done();
      wc.on("did-stop-loading", done);
    });
  }

  // The pane an agent means: the one it names, the one used last, any open one,
  // or a new pane opened for it.
  async function target(paneId, url) {
    if (paneId) {
      if (!tabs.has(String(paneId))) throw new Error("No browser pane " + paneId + ". Call browser_tabs.");
      return tabs.get(String(paneId));
    }
    if (active && tabs.has(active)) return tabs.get(active);
    const first = tabs.values().next().value;
    if (first) return first;
    const opened = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Relay did not open a browser pane. Is the Relay window open?")), 8000);
      attachWaiters.push((id) => {
        clearTimeout(timer);
        resolve(tabs.get(id));
      });
    });
    ctx.send("open", { url: url ? normalizeUrl(url) : HOME });
    const t = await opened;
    await settle(t.view.webContents);
    return t;
  }

  async function run(t, script) {
    return t.view.webContents.executeJavaScript(script, true);
  }

  const srv = ctx.mcp.server("browser", { description: "Relay's built-in browser. The user sees the same page in a browser pane. Use browser_open, then browser_read or browser_screenshot, browser_click and browser_type." });
  const paneProp = { pane: { type: "string", description: "Browser pane id from browser_tabs; default is the one used last" } };

  srv.tool({
    name: "browser_open",
    description: "Open a URL (or search words) in Relay's browser pane, opening a pane if none is open. Waits for the page to load.",
    inputSchema: { type: "object", properties: Object.assign({ url: { type: "string" } }, paneProp), required: ["url"] },
    handler: async (args) => {
      const url = normalizeUrl(args.url);
      const t = await target(args.pane, url);
      active = t.id;
      if (t.view.webContents.getURL() !== url) {
        t.view.webContents.loadURL(url).catch(() => {});
        await new Promise((r) => setTimeout(r, 100));
        await settle(t.view.webContents);
      }
      return state(t.id);
    },
  });

  srv.tool({
    name: "browser_read",
    description: "Read the page in the browser: URL, title, visible text, links, and form fields with CSS selectors you can pass to browser_click and browser_type.",
    inputSchema: { type: "object", properties: Object.assign({ max_chars: { type: "number", description: "Default 15000" } }, paneProp) },
    handler: async (args) => {
      const t = await target(args.pane);
      const max = Math.min(100000, Math.max(500, Number(args.max_chars) || 15000));
      const page = await run(
        t,
        `(() => {
          const sel = (el) => {
            if (el.id) return "#" + CSS.escape(el.id);
            if (el.name) return el.tagName.toLowerCase() + "[name=\\"" + el.name + "\\"]";
            const parts = [];
            for (let n = el; n && n.nodeType === 1 && parts.length < 5; n = n.parentElement) {
              let p = n.tagName.toLowerCase();
              const sib = n.parentElement ? Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName) : [];
              if (sib.length > 1) p += ":nth-of-type(" + (sib.indexOf(n) + 1) + ")";
              parts.unshift(p);
              if (n.id) { parts[0] = "#" + CSS.escape(n.id); break; }
            }
            return parts.join(" > ");
          };
          const seen = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const links = Array.from(document.querySelectorAll("a[href]")).filter(seen).slice(0, 60).map((a) => ({ text: (a.innerText || a.title || "").trim().slice(0, 80), href: a.href }));
          const fields = Array.from(document.querySelectorAll("input, textarea, select, button, [role=button]")).filter(seen).slice(0, 60).map((el) => ({ tag: el.tagName.toLowerCase(), type: el.type || undefined, label: (el.labels && el.labels[0] ? el.labels[0].innerText : el.getAttribute("aria-label") || el.placeholder || el.innerText || el.value || "").trim().slice(0, 60), selector: sel(el) }));
          return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, ${max}), links, fields };
        })()`,
      );
      return page;
    },
  });

  srv.tool({
    name: "browser_screenshot",
    description: "Take a screenshot of the browser pane as the user sees it.",
    inputSchema: { type: "object", properties: paneProp },
    handler: async (args) => {
      const t = await target(args.pane);
      const img = await t.view.webContents.capturePage();
      if (img.isEmpty()) return { content: [{ type: "text", text: "The browser pane is hidden, so there is nothing to capture. Use browser_read, or ask the user to show the pane." }], isError: true };
      const size = img.getSize();
      const scaled = size.width > 1400 ? img.resize({ width: 1400 }) : img;
      return { content: [{ type: "image", data: scaled.toPNG().toString("base64"), mimeType: "image/png" }, { type: "text", text: JSON.stringify(state(t.id)) }] };
    },
  });

  srv.tool({
    name: "browser_click",
    description: "Click an element in the browser by CSS selector, or by its visible text.",
    inputSchema: { type: "object", properties: Object.assign({ selector: { type: "string" }, text: { type: "string", description: "Visible text of a link or button" } }, paneProp) },
    handler: async (args) => {
      const t = await target(args.pane);
      const out = await run(
        t,
        `(() => {
          const selector = ${JSON.stringify(args.selector || "")};
          const text = ${JSON.stringify(String(args.text || "").trim().toLowerCase())};
          let el = selector ? document.querySelector(selector) : null;
          if (!el && text) {
            const all = Array.from(document.querySelectorAll("a, button, [role=button], input[type=submit], input[type=button], summary, label"));
            el = all.find((e) => (e.innerText || e.value || "").trim().toLowerCase() === text) || all.find((e) => (e.innerText || e.value || "").trim().toLowerCase().includes(text));
          }
          if (!el) return { clicked: false };
          el.scrollIntoView({ block: "center" });
          el.click();
          return { clicked: true, element: el.tagName.toLowerCase(), text: (el.innerText || el.value || "").trim().slice(0, 80) };
        })()`,
      );
      if (!out.clicked) throw new Error("Nothing matched " + (args.selector || JSON.stringify(args.text)) + ". Call browser_read for selectors.");
      await new Promise((r) => setTimeout(r, 300));
      await settle(t.view.webContents, 10000);
      return Object.assign(out, state(t.id));
    },
  });

  srv.tool({
    name: "browser_type",
    description: "Type text into a field in the browser (CSS selector from browser_read). submit: true presses Enter afterwards.",
    inputSchema: { type: "object", properties: Object.assign({ selector: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" } }, paneProp), required: ["selector", "text"] },
    handler: async (args) => {
      const t = await target(args.pane);
      const found = await run(
        t,
        `(() => {
          const el = document.querySelector(${JSON.stringify(args.selector)});
          if (!el) return false;
          el.scrollIntoView({ block: "center" });
          el.focus();
          if ("value" in el) {
            const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value");
            if (setter && setter.set) setter.set.call(el, ""); else el.value = "";
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
          return true;
        })()`,
      );
      if (!found) throw new Error("No element matches " + args.selector + ". Call browser_read for selectors.");
      const wc = t.view.webContents;
      await wc.insertText(String(args.text));
      if (args.submit) {
        wc.sendInputEvent({ type: "keyDown", keyCode: "Return" });
        wc.sendInputEvent({ type: "char", keyCode: "\r" });
        wc.sendInputEvent({ type: "keyUp", keyCode: "Return" });
        await new Promise((r) => setTimeout(r, 400));
        await settle(wc, 15000);
      }
      return Object.assign({ typed: true }, state(t.id));
    },
  });

  srv.tool({
    name: "browser_back",
    description: "Go back a page in the browser.",
    inputSchema: { type: "object", properties: paneProp },
    handler: async (args) => {
      const t = await target(args.pane);
      if (t.view.webContents.navigationHistory.canGoBack()) t.view.webContents.navigationHistory.goBack();
      await new Promise((r) => setTimeout(r, 200));
      await settle(t.view.webContents, 10000);
      return state(t.id);
    },
  });

  srv.tool({
    name: "browser_eval",
    description: "Run JavaScript in the page and return its JSON result (the last expression; promises are awaited).",
    inputSchema: { type: "object", properties: Object.assign({ script: { type: "string" } }, paneProp), required: ["script"] },
    handler: async (args) => {
      const t = await target(args.pane);
      const result = await run(t, String(args.script));
      return { result: result === undefined ? null : result };
    },
  });

  srv.tool({
    name: "browser_tabs",
    description: "List Relay's browser panes with their URL and title.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => ({ active, tabs: Array.from(tabs.keys()).map(state) }),
  });
};
