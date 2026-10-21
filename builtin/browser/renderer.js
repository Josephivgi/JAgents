// Browser panes: an address bar in the pane, and the page itself drawn by an
// Electron view (main.cjs) that follows this pane's body around the screen.

const KIND = "browser:tab";

export function activate(jagents) {
  jagents.panes.register("tab", {
    title: "Browser",
    icon: "globe",
    description: "A web page in a pane. Agents can drive it with the browser tools.",
    mount(el, pane) {
      el.innerHTML =
        '<div class="rb-bar">' +
        '<button class="icon-btn" data-nav="back" title="Back">' + jagents.icon("back", 15) + "</button>" +
        '<button class="icon-btn" data-nav="forward" title="Forward">' + jagents.icon("next", 15) + "</button>" +
        '<button class="icon-btn" data-nav="reload" title="Reload">' + jagents.icon("restart", 15) + "</button>" +
        '<form class="rb-form"><input class="rb-url" spellcheck="false" placeholder="Search or type a URL" aria-label="Address"></form>' +
        '<button class="icon-btn" data-nav="external" title="Open in your browser">' + jagents.icon("external", 15) + "</button>" +
        "</div>" +
        '<div class="rb-view"><div class="rb-msg" hidden></div></div>';
      const view = el.querySelector(".rb-view");
      const input = el.querySelector(".rb-url");
      const msg = el.querySelector(".rb-msg");
      let overlay = false;
      let dead = false;
      let last = "";
      let title = pane.state.title || "";

      const send = () => {
        if (dead) return;
        const r = view.getBoundingClientRect();
        const visible = !overlay && pane.visible() && document.visibilityState === "visible";
        const key = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height), visible].join(",");
        if (key === last) return;
        last = key;
        jagents.invoke("bounds", { pane: pane.id, rect: { x: r.left, y: r.top, width: r.width, height: r.height }, visible }).catch(() => {});
      };

      const apply = (s) => {
        if (!s || dead) return;
        if (document.activeElement !== input && s.url) input.value = s.url;
        for (const b of el.querySelectorAll("[data-nav]")) {
          if (b.dataset.nav === "back") b.disabled = !s.canBack;
          if (b.dataset.nav === "forward") b.disabled = !s.canForward;
        }
        el.classList.toggle("rb-loading", Boolean(s.loading));
        msg.hidden = !s.error;
        msg.textContent = s.error ? "Could not load: " + s.error : "";
        if (s.url) pane.setState({ url: s.url, title: s.title || "" });
        const next = (s.title || "").slice(0, 60);
        if (next && next !== title) {
          title = next;
          pane.setTitle(next);
        }
      };

      jagents.invoke("attach", { pane: pane.id, url: pane.state.url || "" }).then(apply).then(() => {
        last = "";
        send();
      });

      el.querySelector(".rb-form").addEventListener("submit", (e) => {
        e.preventDefault();
        jagents.invoke("navigate", { pane: pane.id, url: input.value });
        input.blur();
      });
      input.addEventListener("focus", () => input.select());
      el.querySelector(".rb-bar").addEventListener("click", (e) => {
        const b = e.target.closest("[data-nav]");
        if (b) jagents.invoke("nav", { pane: pane.id, action: b.dataset.nav });
      });

      const ro = new ResizeObserver(send);
      ro.observe(view);
      // Panes also move without resizing (swaps, the sidebar, maximize).
      const timer = setInterval(send, 300);
      const offs = [
        jagents.on("layout", send),
        jagents.on("overlay", (o) => {
          overlay = Boolean(o && o.open);
          send();
        }),
        jagents.onMessage("state", (s) => s && s.pane === pane.id && apply(s)),
      ];
      window.addEventListener("resize", send);
      document.addEventListener("visibilitychange", send);

      return () => {
        dead = true;
        ro.disconnect();
        clearInterval(timer);
        offs.forEach((off) => off());
        window.removeEventListener("resize", send);
        document.removeEventListener("visibilitychange", send);
        jagents.invoke("bounds", { pane: pane.id, visible: false }).catch(() => {});
      };
    },
  });

  // An agent asked for the browser and none is open.
  jagents.onMessage("open", (o) => jagents.panes.open("tab", { title: "Browser", state: { url: (o && o.url) || "" } }));

  // Views for closed panes go away in main.cjs.
  const sync = (list) => jagents.invoke("sync", { panes: (list || []).filter((p) => p.kind === "plugin" && p.pluginKind === KIND).map((p) => p.id) }).catch(() => {});
  jagents.on("panes-changed", sync);
  sync(jagents.store.panes);
}
