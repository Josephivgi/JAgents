#!/usr/bin/env node
"use strict";

// JAgents Terminal: one process that runs many named terminals (Claude Code,
// Codex, a shell, and the rest JAgents finds) in one window. Tabs on top, a
// sidebar listing every terminal, splits right or down. It is its own app,
// separate from JAgents Desktop: its own look, data, plugins and MCP
// (jagents-terminal). Subagents come from JMCP (Ctrl+B j), which it offers to
// install. The Desktop button opens the desktop app on the same folder.
//   jagents              open the multiplexer
//   jagents <agent>      open it with that agent in the first tab (jagents claude)
//   jagents desktop      open the desktop app and return
//   jagents jmcp         JMCP status and subagents (watch, install, connect)
//   jagents install-desktop   download the desktop setup from GitHub and run it
//   jagents update       reinstall this app from the latest GitHub release
//   jagents --version    this app's version, and the desktop app's
//   jagents --list       list the terminal agents and whether they are installed
// Each pane is a real PTY (node-pty) read into a headless xterm, and the
// screen is drawn from those buffers (tui.cjs). Terminals here are separate
// from the desktop app's and close when this window does.
//
// Updates apply while it runs: this file only holds the screen and the
// programs. When tui.cjs or a file it loads changes, or `jagents update`
// installs a new version next to this one, the new code takes over the same
// terminals without closing them.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_ROOT = path.join(__dirname, "..");
const pkg = require(path.join(APP_ROOT, "package.json"));
const { listTerminalAgents } = require(path.join(APP_ROOT, "lib", "agents"));
const desk = require("./desktop.cjs");

const INSTALL_PS1 = "https://raw.githubusercontent.com/" + desk.REPO + "/main/install-terminal.ps1";
const ESC = "\x1b";
const CSI = ESC + "[";

// ---- command line ---------------------------------------------------------

const argv = process.argv.slice(2);
if (argv[0] === "terminal") argv.shift();
if (argv[0] === "mcp") {
  require("../mcp/jagents-terminal-mcp.cjs");
  return;
}
if (argv[0] === "mcp-config") {
  process.stdout.write(JSON.stringify(require("./terminal-runtime.cjs").mcpConfig(), null, 2) + "\n");
  return;
}
if (argv[0] === "jmcp") {
  jmcpCommand(argv[1] || "");
  return;
}
if (argv[0] === "plugins") {
  if (argv[1] === "docs") {
    process.stdout.write(require("./plugin-docs.cjs"));
    return;
  }
  if (argv[1]) {
    process.stderr.write("Use jagents plugins to list plugins, or jagents plugins docs for the API. Manage plugins with Ctrl+B e or the terminal MCP.\n");
    process.exitCode = 1;
    return;
  }
  const runtime = require("./terminal-runtime.cjs").createRuntime({ ui: () => null });
  try { process.stdout.write(JSON.stringify(runtime.plugins.list(), null, 2) + "\n"); }
  finally { runtime.stop(); }
  return;
}
if (argv.includes("--help") || argv.includes("-h")) {
  process.stdout.write(
    [
      "JAgents Terminal " + pkg.version,
      "",
      "  jagents              open named terminals in this folder",
      "  jagents <agent>      start with that agent (claude, codex, shell, omp, ...)",
      "  jagents desktop      open the JAgents desktop app on this folder",
      "  jagents install-desktop   install the latest desktop release from GitHub,",
      "                       or reinstall it if you have it (--yes skips the question),",
      "                       then ask to pin it (--pin or --no-pin skips that)",
      "  jagents pin          pin JAgents Desktop to the taskbar",
      "  jagents update       install the latest version of this app from GitHub;",
      "                       open jagents windows switch to it on their own",
      "  jagents --list       list terminal agents",
      "  jagents --version    show versions",
      "  jagents plugins      list terminal plugins (plugins docs prints the API)",
      "  jagents mcp          dedicated terminal MCP server over stdio",
      "  jagents mcp-config   print an MCP client connection entry",
      "  jagents jmcp         JMCP status and recent subagents",
      "  jagents jmcp watch   the same, live (q closes)",
      "  jagents jmcp install install JMCP from its latest GitHub release",
      "  jagents jmcp connect connect JMCP to this app (jmcp tools in panes)",
      "",
      "Inside: click tabs, the sidebar and buttons, or press Ctrl+B then a key.",
      "Ctrl+B ? lists the keys.",
      "Ctrl+B e opens Plugins. Claude Code and Codex panes get terminal MCP tools.",
      "Ctrl+B j shows JMCP subagents, or offers to install JMCP for MCP servers.",
      "The jagents-terminal MCP works without JMCP.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
  const version = desk.desktopVersion();
  process.stdout.write(
    [
      "JAgents Terminal " + pkg.version,
      "  at " + APP_ROOT,
      version ? "JAgents Desktop " + version : "JAgents Desktop not installed (jagents install-desktop)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}
// Runs cli/pin-taskbar.ps1 and exits with its result.
function pinToTaskbar() {
  process.stdout.write("Pinning (Explorer restarts for a moment)…\n");
  const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "pin-taskbar.ps1")], { stdio: "inherit", windowsHide: true });
  ps.on("exit", (code) => process.exit(code || 0));
}

function ask(question, done) {
  const rl = require("node:readline").createInterface({ input: process.stdin, output: process.stdout });
  rl.question(question, (answer) => {
    rl.close();
    done(answer.trim());
  });
}

// Installs the latest release; when a copy is already there it says so and
// asks first, since installing again replaces it.
function installDesktopCommand() {
  const have = desk.desktopVersion() || (desk.desktopSetupInstalled() ? "?" : "");
  if (!have || argv.includes("--yes") || argv.includes("-y") || !process.stdin.isTTY) return runInstallDesktop();
  desk.latestRelease((err, release) => {
    const latest = !err && release.tag ? release.tag : "the latest release";
    const same = !err && desk.sameVersion(have, release.tag);
    process.stdout.write("JAgents Desktop " + (have === "?" ? "" : have + " ") + "is already installed.\n");
    process.stdout.write((same ? "Installing again reinstalls " + latest + " over it." : "Installing replaces it with " + latest + ".") + " Your chats and settings stay.\n");
    ask("Reinstall? (Y/n) ", (answer) => {
      if (/^n/i.test(answer)) return process.exit(0);
      runInstallDesktop();
    });
  });
}

function runInstallDesktop() {
  desk.installDesktop(
    (step) => process.stdout.write("\r" + step.padEnd(64)),
    (err, done) => {
      process.stdout.write("\n");
      if (err) {
        process.stderr.write(String(err.message || err) + "\n");
        process.exit(1);
      }
      process.stdout.write("JAgents Desktop " + ((done && (done.version || done.tag)) || "") + " is installed.\n");
      if (argv.includes("--pin")) return pinToTaskbar();
      if (argv.includes("--no-pin") || !process.stdin.isTTY) return process.exit(0);
      ask("Pin JAgents to the taskbar? (y/N) ", (answer) => {
        if (/^y/i.test(answer)) return pinToTaskbar();
        process.exit(0);
      });
    },
  );
}

// jagents jmcp [watch | install | connect]
function jmcpCommand(sub) {
  const jmcp = require("./jmcp.cjs");
  const plugins = path.join(require("./terminal-runtime.cjs").DATA, "plugins");
  if (!sub) {
    process.stdout.write(jmcp.report(plugins, process.stdout.columns, process.stdout.rows) + "\n");
    return;
  }
  if (sub === "watch") return jmcp.watch(plugins);
  if (sub === "connect") {
    jmcp.connect((err) => {
      if (err) {
        process.stderr.write(String(err.message || err) + "\n");
        process.exit(1);
      }
      process.stdout.write("JMCP is connected. Open JAgents Terminal windows load the jmcp plugin now.\n");
    });
    return;
  }
  if (sub === "install") {
    if (jmcp.status(plugins).app && !argv.includes("--yes") && !argv.includes("-y")) {
      process.stdout.write("JMCP is already installed. jagents jmcp install --yes reinstalls the latest release.\n");
      return;
    }
    jmcp.install(
      (step) => process.stdout.write("\r" + step.padEnd(64)),
      (err, done) => {
        process.stdout.write("\n");
        if (err) {
          process.stderr.write(String(err.message || err) + "\n");
          process.exit(1);
        }
        process.stdout.write("JMCP " + ((done && (done.version || done.tag)) || "") + " is installed. Open it to install its servers into your agents.\n");
      },
    );
    return;
  }
  process.stderr.write("Use jagents jmcp, jagents jmcp watch, jagents jmcp install or jagents jmcp connect.\n");
  process.exitCode = 1;
}

if (argv[0] === "pin") {
  pinToTaskbar();
  return;
}
if (argv[0] === "install-desktop") {
  installDesktopCommand();
  return;
}
if (argv[0] === "update") {
  if (process.platform !== "win32") {
    process.stderr.write("jagents update runs install-terminal.ps1, which is for Windows.\n");
    process.exit(1);
  }
  const ps = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", "irm " + INSTALL_PS1 + " | iex"], { stdio: "inherit", windowsHide: true });
  ps.on("exit", (code) => process.exit(code || 0));
  return;
}
if (argv.includes("--list")) {
  for (const t of listTerminalAgents()) process.stdout.write((t.available ? "  " : "- ") + t.id.padEnd(14) + t.name + (t.available ? "" : "  (not installed)") + "\n");
  process.exit(0);
}
if (argv[0] === "desktop") {
  process.stdout.write("Opening JAgents on " + process.cwd() + "\n");
  desk.openDesktop(process.cwd(), (err) => {
    if (err) process.stderr.write(err + "\n");
    process.exit(err ? 1 : 0);
  });
  return;
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("jagents needs an interactive terminal.\n");
  process.exit(1);
}

// ---- the host -------------------------------------------------------------

// cli/node_modules when installed by install-terminal.ps1, the app's own in a checkout.
// Loaded once: the panes' programs belong to these copies for the session.
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");

const out = process.stdout;
let root = APP_ROOT; // the app folder the screen's code comes from
let ui = null; // the loaded tui.cjs
const host = {
  state: {},
  pty,
  Terminal,
  argv,
  reloaded: false,
  ui: () => ui,
  quit,
  reload: () => reload(root),
  runtime: null,
};

function restoreScreen() {
  try {
    out.write(CSI + "?1003l" + CSI + "?1002l" + CSI + "?1006l" + CSI + "?2004l" + CSI + "?1l" + ESC + ">" + CSI + "0m" + CSI + "?25h" + CSI + "?1049l");
    process.stdin.setRawMode(false);
  } catch {
    /* closing */
  }
}

function quit() {
  restoreScreen();
  process.exit(0);
}

// Our own files, not packages: they are dropped from the require cache so a
// reload reads them again.
function ownFile(file) {
  return !/[\\/]node_modules[\\/]/.test(file) && file !== __filename;
}

function loadUi(from) {
  for (const k of Object.keys(require.cache)) if (ownFile(k)) delete require.cache[k];
  return require(path.join(from, "cli", "tui.cjs"));
}

// Loads the new code first; if it does not load or start, the old copy keeps
// the screen and says why.
function reload(from, why) {
  let next;
  try {
    next = loadUi(from);
  } catch (error) {
    return ui && ui.flash("Update not applied: " + firstLine(error) + ". Still on the old code.", "danger");
  }
  const prev = ui;
  prev.stop();
  host.reloaded = true;
  try {
    ui = next;
    ui.start(host);
    root = from;
    watchCode();
    if (why) ui.flash(why, "ok");
  } catch (error) {
    ui = prev;
    prev.start(host);
    prev.flash("Update not applied: " + firstLine(error) + ". Still on the old code.", "danger");
  }
}

function firstLine(error) {
  return String((error && error.message) || error).split("\n")[0];
}

// A checkout (or anyone editing the files): watch cli\ and lib\ and reload a
// moment after the last change, so a save in several steps reloads once.
let watchers = [];
let codeTimer = null;
let hostChanged = false;
function watchCode() {
  for (const w of watchers) w.close();
  watchers = [];
  for (const dir of ["cli", "lib"]) {
    try {
      const w = fs.watch(path.join(root, dir), { recursive: true }, (_event, name) => {
        if (!name || !/\.(c?js|json)$/.test(name)) return;
        if (path.basename(name) === "jagents.cjs" && dir === "cli") hostChanged = true;
        clearTimeout(codeTimer);
        codeTimer = setTimeout(() => {
          const note = hostChanged ? "Reloaded. Changes to jagents.cjs itself apply the next time you open jagents." : "";
          hostChanged = false;
          reload(root, note);
        }, 400);
      });
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      /* folder missing */
    }
  }
}

// An install (install-terminal.ps1) puts each version in its own folder next to this
// one and writes that folder's path to current.txt last. A running window
// moves to it: the old folder stays in use until this window closes.
const CURRENT = path.join(path.dirname(APP_ROOT), "current.txt");
function readCurrent() {
  try {
    const p = fs.readFileSync(CURRENT, "utf8").trim();
    return p && fs.existsSync(path.join(p, "cli", "tui.cjs")) ? p : "";
  } catch {
    return "";
  }
}
if (fs.existsSync(CURRENT)) {
  // This window runs node-pty from APP_ROOT for as long as it is open; the
  // mark tells install-terminal.ps1 to leave the folder alone.
  const mark = path.join(APP_ROOT, ".running", String(process.pid));
  try {
    fs.mkdirSync(path.dirname(mark), { recursive: true });
    fs.writeFileSync(mark, "");
    process.on("exit", () => fs.rmSync(mark, { force: true }));
  } catch {
    /* read-only folder: nothing to mark */
  }
  fs.watchFile(CURRENT, { interval: 1500 }, () => {
    const next = readCurrent();
    if (!next || path.resolve(next) === path.resolve(root)) return;
    let version = "";
    try {
      version = JSON.parse(fs.readFileSync(path.join(next, "package.json"), "utf8")).version;
    } catch {
      /* unknown */
    }
    reload(next, "Updated to JAgents Terminal " + version + ". Your terminals kept running.");
  });
}

process.on("exit", () => {
  host.runtime?.stop();
  restoreScreen();
});
process.on("uncaughtException", (error) => {
  restoreScreen();
  process.stderr.write("jagents: " + (error.stack || error) + "\n");
  process.exit(1);
});

// 1003: report motion too, so buttons light up under the mouse.
out.write(CSI + "?1049h" + ESC + "]0;JAgents Terminal" + "\x07" + CSI + "2J" + CSI + "?1003h" + CSI + "?1006h");
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on("data", (chunk) => ui?.onInput(chunk));
out.on("resize", () => ui?.onResize());

host.runtime = require("./terminal-runtime.cjs").createRuntime(host, { deferPlugins: true });
host.runtime.start().then(() => {
  ui = loadUi(root);
  ui.start(host);
  watchCode();
}).catch((error) => {
  restoreScreen();
  process.stderr.write("jagents: " + firstLine(error) + "\n");
  process.exit(1);
});
