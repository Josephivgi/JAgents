// Help mode: a guide to the JAgents MCP server. The sidebar lists the
// sections; the tool reference and the agent support table come live from the
// main process, so they match what agents actually get.

import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, on } from "./store.js";
import { openHubPanel, openUpdatesPanel } from "./dialogs.js";

const SECTIONS = [
  ["overview", "What it is"],
  ["turn-on", "Turn it on"],
  ["who", "Which agents get it"],
  ["tools", "Tools"],
  ["examples", "Things to ask"],
  ["outside", "Agents outside JAgents"],
  ["auto", "Auto MCP"],
  ["plugins", "Plugins and the MCP"],
  ["trouble", "Troubleshooting"],
  ["updates", "Version and updates"],
];

let side = null;
let main = null;
let observer = null;

function paramList(schema) {
  const props = (schema && schema.properties) || {};
  const req = new Set((schema && schema.required) || []);
  const names = Object.keys(props);
  if (!names.length) return '<p class="muted small">No arguments.</p>';
  return (
    '<dl class="help-params">' +
    names
      .map((n) => {
        const p = props[n] || {};
        const type = Array.isArray(p.type) ? p.type.join(" | ") : p.type || "any";
        return "<dt><code>" + esc(n) + '</code> <span class="muted small">' + esc(type) + (req.has(n) ? ", required" : "") + "</span></dt><dd>" + esc(p.description || "") + "</dd>";
      })
      .join("") +
    "</dl>"
  );
}

function toolsMarkup(res) {
  if (!res) return '<p class="muted small"><span class="spinner"></span> Loading tools…</p>';
  if (res.error) return '<p class="err-row">' + esc(res.error) + "</p>";
  return res.tools
    .map((t) => '<details class="help-tool"><summary><code>mcp__' + esc(res.server) + "__" + esc(t.name) + "</code><span>" + esc(t.description) + "</span></summary>" + paramList(t.inputSchema) + "</details>")
    .join("");
}

function supportMarkup(rows) {
  if (!rows) return '<p class="muted small"><span class="spinner"></span> Checking agents…</p>';
  if (rows.error) return '<p class="err-row">' + esc(rows.error) + "</p>";
  const label = { auto: "Automatic", global: "Global install" };
  return (
    '<table class="help-table"><thead><tr><th>Agent</th><th>Runs as</th><th>How it gets the MCP</th><th>On this computer</th></tr></thead><tbody>' +
    rows
      .map(
        (r) =>
          '<tr><td><span class="help-agent">' + harnessIcon(r.id, 16) + esc(r.name) + '</span></td><td><span class="pill">' + esc(r.where) + '</span></td><td><span class="pill ' + (r.mode === "auto" ? "ok" : "") + '">' + esc(label[r.mode] || r.mode) + '</span> <span class="muted small">' + esc(r.how) + "</span></td><td>" + (r.available ? '<span class="pill ok">Installed</span>' : '<span class="muted small">Not installed</span>') + "</td></tr>",
      )
      .join("") +
    "</tbody></table>"
  );
}

function runningMarkup() {
  const list = store.hubAgents || [];
  if (!list.length) return '<p class="muted small">No agents running right now.</p>';
  return (
    '<div class="help-running">' +
    list.map((a) => '<span class="chip' + (a.mcp ? " hub" : "") + '">' + harnessIcon(a.provider, 12) + esc(a.handle) + (a.mcp ? " · has MCP" : " · no MCP") + "</span>").join("") +
    "</div>"
  );
}

function article() {
  const v = store.info.version || "";
  return (
    '<article class="help-doc">' +
    '<header class="help-hero">' + icon("hub", 26) + '<div><h1>JAgents MCP guide</h1><p class="muted">The <code>jagents</code> MCP server lets the coding agents in this app see each other, talk, share work, and start helpers.</p></div></header>' +

    '<section id="help-overview"><h2>What it is</h2>' +
    "<p>Every agent JAgents starts can get an MCP server named <code>jagents</code>. Its tools reach the hub inside the app, which knows every terminal, chat, and subagent. Through it an agent can list the other agents, send one a message, read another agent's screen or transcript, start a subagent on a task and wait for its answer, or hand its whole context to another agent.</p>" +
    "<p>In Claude Code the tools show up as <code>mcp__jagents__list_agents</code>, <code>mcp__jagents__send_message</code>, and so on.</p></section>" +

    '<section id="help-turn-on"><h2>Turn it on</h2><ol>' +
    "<li>Open <b>MCP hub</b> in the top bar.</li>" +
    "<li>Turn on <b>Connect terminals launched in JAgents</b>.</li>" +
    "<li>Restart any terminal that was already open (the Restart button in its pane header). New terminals get it on their own.</li>" +
    "</ol><p>Chats (ACP agents and Claude Code through the Agent SDK) always get the server; the switch is for terminals.</p>" +
    '<p class="help-status">' + (store.info.hubAttach ? '<span class="pill ok">On</span> Terminals launched now get the jagents server.' : '<span class="pill">Off</span> Terminals launch without the jagents server.') + ' <button class="btn sm secondary" data-help="hub">' + icon("hub", 14) + "Open MCP hub</button></p></section>" +

    '<section id="help-who"><h2>Which agents get it</h2><p>How each kind of agent gets the server. Automatic means JAgents wires it up at launch with nothing to install.</p><div data-help-support>' + supportMarkup(null) + "</div>" +
    '<h3>Running now</h3><div data-help-running>' + runningMarkup() + "</div></section>" +

    '<section id="help-tools"><h2>Tools</h2><p>This is the live list the hub gives agents. Plugins can turn tools off, and those are left out here too.</p><div data-help-tools>' + toolsMarkup(null) + "</div></section>" +

    '<section id="help-examples"><h2>Things to ask</h2><p>Type these to any agent that has the server:</p><ul class="help-examples">' +
    "<li>“List the other agents and tell me what each one is working on.”</li>" +
    "<li>“Send codex-1 a message asking it to run the tests and report back.”</li>" +
    "<li>“Spawn a Devin subagent to write docs for the API folder, and wait for it.”</li>" +
    "<li>“Read claude-2's last 200 lines and summarize the error it hit.”</li>" +
    "<li>“Hand off your context to a new Codex terminal so it can finish the refactor.”</li>" +
    "</ul></section>" +

    '<section id="help-outside"><h2>Agents outside JAgents</h2><p>Sessions you start in your own terminal can reach JAgents too. In <b>MCP hub</b>, under <b>Install globally</b>, press Install next to Claude Code, Codex, Cursor, or Gemini CLI. That writes the <code>jagents</code> server into the agent\'s own config. Remove it there any time.</p>' +
    "<p>An agent outside the app has no handle, so <code>whoami</code> says so, but it can still list, read, and message JAgents agents. JAgents has to be open for the tools to answer.</p></section>" +

    '<section id="help-auto"><h2>Auto MCP</h2><p>Auto MCP runs when JAgents starts and every 10 minutes:</p><ul>' +
    "<li><b>Keep installs up to date</b> (on by default): fixes global installs that point at an old script or Node.</li>" +
    "<li><b>Install in every supported agent</b> (off by default): also adds the server to each supported agent that is on this computer but does not have it yet.</li>" +
    "</ul><p>Both switches are in <b>MCP hub</b>, which also shows what the last run changed.</p>" +
    "<p>To bring over your Relay threads, layout, plugins, and MCP setup, press <b>Import from legacy Relay</b> in <b>MCP hub > Legacy (development)</b>, then restart.</p></section>" +

    '<section id="help-plugins"><h2>Plugins and the MCP</h2><p>A plugin can add MCP servers that every agent gets, or turn tools off with <code>disableTools</code> in its plugin.json. Use <code>jagents.spawn_subagent</code> to turn off a JAgents tool. Plugins written before the rename that say <code>relay.spawn_subagent</code> still work.</p></section>' +

    '<section id="help-trouble"><h2>Troubleshooting</h2><dl class="help-faq">' +
    "<dt>“JAgents is not running”</dt><dd>The server could not reach the hub. Open the JAgents app, then try again. The hub address is in <span class=\"mono\">" + esc((store.info.hubDir || "~/.jagents") + "/hub.json") + "</span>.</dd>" +
    "<dt>A terminal has no jagents tools</dt><dd>It started before the hub switch was on. Restart that terminal. Shell and Cursor Agent terminals only have it through a global install.</dd>" +
    "<dt>whoami returns no handle</dt><dd>The agent was not started by JAgents (for example, a global install used from your own terminal).</dd>" +
    "<dt>A subagent never answers</dt><dd>Call <code>wait_for_agent</code> again with a longer <code>timeout_seconds</code> (up to 900), or open its thread to see what it is doing.</dd>" +
    "</dl></section>" +

    '<section id="help-updates"><h2>Version and updates</h2><p>This is JAgents <b>v' + esc(v) + "</b>. The version button in the top bar shows it and gets a dot when a newer GitHub release is out. Open it to read the release notes, install the update, and restart when you are ready.</p>" +
    '<p><button class="btn sm secondary" data-help="updates">' + icon("update", 14) + "Check for updates</button></p></section>" +
    "</article>"
  );
}

async function loadLive() {
  const tools = main.querySelector("[data-help-tools]");
  const support = main.querySelector("[data-help-support]");
  window.jagents.hub
    .tools()
    .then((res) => (tools.innerHTML = toolsMarkup(res)))
    .catch((error) => (tools.innerHTML = toolsMarkup({ error: errorText(error) })));
  window.jagents.hub
    .support()
    .then((rows) => (support.innerHTML = supportMarkup(rows)))
    .catch((error) => (support.innerHTML = supportMarkup({ error: errorText(error) })));
}

function paintSide(activeId) {
  side.querySelector("[data-help-nav]").innerHTML = SECTIONS.map(([id, title]) => '<button class="thread-item help-nav' + (id === activeId ? " active" : "") + '" data-help-go="' + id + '"><span class="grow"><span class="t">' + esc(title) + "</span></span></button>").join("");
}

export function renderHelpMode(sideEl, mainEl) {
  side = sideEl;
  main = mainEl;
  side.innerHTML = '<p class="nav-label">MCP guide</p><div class="thread-list" data-help-nav></div>';
  main.innerHTML = '<div class="help-scroll" data-help-scroll>' + article() + "</div>";
  paintSide("overview");
  side.addEventListener("click", (e) => {
    const go = e.target.closest("[data-help-go]");
    if (!go) return;
    const el = main.querySelector("#help-" + go.dataset.helpGo);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    paintSide(go.dataset.helpGo);
  });
  main.addEventListener("click", (e) => {
    const b = e.target.closest("[data-help]");
    if (!b) return;
    if (b.dataset.help === "hub") openHubPanel().catch((error) => toast(errorText(error)));
    if (b.dataset.help === "updates") openUpdatesPanel(true).catch((error) => toast(errorText(error)));
  });
  const scroller = main.querySelector("[data-help-scroll]");
  if (observer) observer.disconnect();
  observer = new IntersectionObserver(
    (entries) => {
      const hit = entries.filter((x) => x.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (hit) paintSide(hit.target.id.replace(/^help-/, ""));
    },
    { root: scroller, rootMargin: "0px 0px -70% 0px" },
  );
  for (const s of main.querySelectorAll(".help-doc section")) observer.observe(s);
  loadLive();
  on("hub-agents", () => {
    const box = main.querySelector("[data-help-running]");
    if (box) box.innerHTML = runningMarkup();
  });
  on("hub", () => {
    main.querySelector("[data-help-scroll]").innerHTML = article();
    for (const s of main.querySelectorAll(".help-doc section")) observer.observe(s);
    loadLive();
  });
}

// Called when Help mode opens, so the tool list reflects plugin changes.
export function refreshHelp() {
  if (main) loadLive();
}
