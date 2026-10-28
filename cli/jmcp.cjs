"use strict";

// JMCP, seen from JAgents Terminal. JMCP (github.com/Josephivgi/JMCP) installs
// MCP servers (subagents, memory, rules, skills, health, a browser) into the
// coding agents on this computer, so the agents in terminal panes get them
// too. This file finds JMCP, reads its own data to show its servers and the
// subagents agents started through jmcp-subagents, installs JMCP from its
// latest GitHub release, and connects it to this app when JMCP can.
// The terminal's own jagents-terminal MCP does not need any of this.
//   node jmcp.cjs          JMCP status and recent subagents, once
//   node jmcp.cjs watch    the same, refreshed until q or Ctrl+C

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const desk = require("./desktop.cjs");

const REPO = "Josephivgi/JMCP";
const RELEASES = "https://github.com/" + REPO + "/releases/latest";
const RELEASE_API = "https://api.github.com/repos/" + REPO + "/releases/latest";
const SETUP_RE = /^JMCP-Setup-[\w.-]+\.exe$/;
const APP_ID = "jagents-terminal";
// Subagent states that mean it is working on something right now.
const WORKING = new Set(["starting", "running", "busy"]);

// JMCP's data: servers it installed, subagents.db, connections.db.
function home() {
  return process.env.JMCP_HOME || path.join(os.homedir(), ".jmcp");
}

// Where JMCP-Setup installs the app (per user, no admin).
function appDir() {
  return process.env.JMCP_APP_DIR || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Programs", "jmcp");
}

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function appExe() {
  const exe = path.join(appDir(), "JMCP.exe");
  return exists(exe) ? exe : "";
}

function cliFile() {
  const file = path.join(appDir(), "resources", "app", "cli", "jmcp.cjs");
  return exists(file) ? file : "";
}

function appVersion() {
  return String((readJson(path.join(appDir(), "resources", "app", "package.json")) || {}).version || "");
}

// JMCP servers in ~/.jmcp/servers, with their versions.
function servers() {
  const dir = path.join(home(), "servers");
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && /^[a-z]+$/.test(e.name)).map((e) => e.name).sort();
  } catch {
    return [];
  }
  return names
    .filter((id) => exists(path.join(dir, id, "server.cjs")))
    .map((id) => ({ id, name: "jmcp-" + id, version: String((readJson(path.join(dir, id, "package.json")) || {}).version || "") }));
}

// Subagents started through jmcp-subagents by any agent, newest first.
// Read only: jmcp-subagents owns the file. The screen calls this, so a
// locked file fails fast instead of holding up the window.
function subagents(limit) {
  const file = path.join(home(), "subagents.db");
  if (!exists(file)) return [];
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=200");
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subagents'").get()) return [];
    const n = Math.max(1, Math.min(200, Number(limit) || 20));
    return db
      .prepare("SELECT handle, parent, provider_name AS provider, model, status, task, cwd, error, updated_at AS updatedAt FROM subagents ORDER BY updated_at DESC LIMIT ?")
      .all(n)
      .map((r) => ({ ...r, task: String(r.task || "").replace(/\s+/g, " ").trim().slice(0, 300) }));
  } finally {
    db.close();
  }
}

// The jmcp plugin JMCP writes into this app's plugins folder when it
// connects it. It gives panes a jmcp MCP server and adds JMCP commands.
function pluginConnected(pluginsDir) {
  const mark = pluginsDir ? readJson(path.join(pluginsDir, "jmcp", "connection.json")) : null;
  return Boolean(mark && mark.by === "JMCP");
}

// JMCP versions before Connections have no `jmcp connect`.
function canConnect() {
  const file = cliFile();
  if (!file) return false;
  try {
    return fs.readFileSync(file, "utf8").includes('cmd === "connect"');
  } catch {
    return false;
  }
}

// Everything the screen shows, in one call. Never throws.
function status(pluginsDir, limit) {
  const s = { installed: false, app: Boolean(appExe()), version: appVersion(), home: home(), servers: servers(), subagents: [], working: 0, error: "", connected: pluginConnected(pluginsDir), canConnect: false };
  s.installed = s.app || Boolean(cliFile()) || s.servers.length > 0;
  if (!s.installed) return s;
  s.canConnect = !s.connected && canConnect();
  try {
    s.subagents = subagents(limit);
  } catch (e) {
    s.error = "Could not read subagents: " + (e.message || e);
  }
  s.working = s.subagents.filter((x) => WORKING.has(x.status)).length;
  return s;
}

// Asks the installed JMCP to connect this app. done(err).
function connect(done) {
  const cli = cliFile();
  if (!cli) return done(new Error("JMCP is not installed."));
  if (!canConnect()) return done(new Error("This JMCP version cannot connect apps yet. Update JMCP, then try again."));
  execFile(process.execPath, [cli, "connect", APP_ID], { windowsHide: true, timeout: 30000 }, (err, _stdout, stderr) => {
    if (!err) return done(null);
    const why = String(stderr || "").trim().split("\n").pop();
    done(new Error(why || err.message));
  });
}

// The app's window, for settings and installing servers into agents.
function openApp(done) {
  const exe = appExe();
  if (!exe) return done("JMCP is not installed.");
  try {
    const child = spawn(exe, [], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (e) => done("Could not open JMCP: " + (e.message || e)));
    child.unref();
    setTimeout(() => done(""), 1500);
  } catch (e) {
    done("Could not open JMCP: " + (e.message || e));
  }
}

// The latest public release's setup: done(null, {tag, url}).
function latestRelease(done) {
  desk.get(
    RELEASE_API,
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const release = JSON.parse(body);
          const asset = (release.assets || []).find((a) => SETUP_RE.test(a.name));
          if (!asset) return done(new Error("The latest JMCP release (" + release.tag_name + ") has no setup. Get it from " + RELEASES));
          done(null, { tag: release.tag_name, url: asset.browser_download_url });
        } catch (e) {
          done(e);
        }
      });
      res.on("error", done);
    },
    (err) => done(new Error("Could not reach GitHub (" + (err.message || err) + "). Get JMCP from " + RELEASES)),
  );
}

// Downloads the latest JMCP setup from GitHub and runs it silently. It
// installs per user (no admin) and does not open the app.
// JMCP_SETUP_ARGS adds setup arguments (tests use /D=<folder>).
// onStep(text, pct) reports progress; done(err, {version, tag}).
function install(onStep, done) {
  if (process.platform !== "win32") return done(new Error("The JMCP setup is for Windows. See " + RELEASES));
  onStep("Finding the latest JMCP release…", -1);
  latestRelease((err, release) => {
    if (err) return done(err);
    const name = "JMCP " + release.tag;
    const file = path.join(os.tmpdir(), "JMCP-Setup-" + process.pid + "-" + Date.now() + ".exe");
    let lastPct = -2;
    onStep("Downloading " + name + " from GitHub…", 0);
    desk.download(
      release.url,
      file,
      (got, total) => {
        const pct = total ? Math.floor((got / total) * 100) : -1;
        if (pct === lastPct) return;
        lastPct = pct;
        const mb = (n) => (n / 1048576).toFixed(0);
        onStep("Downloading " + name + " " + (total ? pct + "% (" + mb(got) + " of " + mb(total) + " MB)" : mb(got) + " MB"), pct);
      },
      (dlErr) => {
        if (dlErr) {
          fs.rm(file, { force: true }, () => {});
          return done(dlErr);
        }
        onStep("Installing " + name + "…", 100);
        const extra = (process.env.JMCP_SETUP_ARGS || "").split(" ").filter(Boolean);
        const child = spawn(file, ["/S", "/currentuser"].concat(extra), { stdio: "ignore", windowsHide: true });
        child.on("error", done);
        child.on("exit", (code) => {
          fs.rm(file, { force: true }, () => {});
          if (code) return done(new Error("JMCP setup exited with code " + code + ". If JMCP is open, close it and try again."));
          done(null, { version: appVersion(), tag: release.tag });
        });
      },
    );
  });
}

function ago(t) {
  if (!t) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? s + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago";
}

function cut(text, n) {
  const t = String(text || "");
  return t.length > n ? t.slice(0, Math.max(0, n - 1)) + "…" : t;
}

// One subagent as a fixed-width line: handle, status, provider, age, task.
function subagentLine(s, width) {
  const head = cut(s.handle, 14).padEnd(15) + cut(s.status, 9).padEnd(10) + cut(s.provider, 14).padEnd(15) + ago(s.updatedAt).padEnd(9);
  return head + cut(s.task, Math.max(0, width - head.length));
}

// Plain text for `jagents jmcp` and the JMCP tab.
function report(pluginsDir, width, rows) {
  const w = Math.max(40, width || 100);
  const s = status(pluginsDir, Math.max(5, (rows || 30) - 12));
  const lines = [];
  if (!s.installed) {
    lines.push(
      "JMCP is not installed.",
      "",
      "JMCP installs MCP servers (subagents, memory, rules, skills, health, a browser)",
      "into the coding agents on this computer, so agents in JAgents Terminal get them too,",
      "and this window can list their subagents.",
      "",
      "Install it with: jagents jmcp install",
      "Or download it from " + RELEASES,
      "",
      "JAgents Terminal's own MCP (jagents-terminal) works without JMCP.",
    );
    return lines.join("\n");
  }
  lines.push("JMCP" + (s.version ? " " + s.version : "") + (s.connected ? "  connected to JAgents Terminal" : ""), "");
  lines.push("Servers (" + s.servers.length + ")");
  if (!s.servers.length) lines.push("  None installed. Install them on the JMCP servers page.");
  for (const x of s.servers) lines.push("  " + x.name.padEnd(20) + x.version);
  lines.push("");
  lines.push("Subagents (" + s.working + " working, " + s.subagents.length + " recent)");
  if (s.error) lines.push("  " + s.error);
  else if (!s.subagents.length) lines.push("  None yet. Agents start them with jmcp-subagents.");
  for (const x of s.subagents) lines.push("  " + subagentLine(x, w - 3));
  return lines.map((l) => cut(l, w)).join("\n");
}

function watch(pluginsDir) {
  const out = process.stdout;
  const draw = () => out.write("\x1b[H\x1b[2J" + report(pluginsDir, out.columns, out.rows).replace(/\n/g, "\r\n") + "\r\n\r\nq closes. Refreshes every 3s.");
  const done = () => {
    out.write("\x1b[?25h\r\n");
    process.exit(0);
  };
  out.write("\x1b]0;JMCP\x07\x1b[?25l");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (b) => {
      const k = String(b);
      if (k === "q" || k === "Q" || k === "\x03") done();
    });
  }
  process.on("SIGINT", done);
  out.on("resize", draw);
  draw();
  setInterval(draw, 3000);
}

module.exports = { REPO, RELEASES, APP_ID, WORKING, home, appDir, appExe, cliFile, servers, subagents, pluginConnected, canConnect, status, connect, openApp, latestRelease, install, report, watch, subagentLine, ago };

if (require.main === module) {
  const plugins = process.argv[3] || "";
  if (process.argv[2] === "watch") watch(plugins);
  else process.stdout.write(report(plugins, process.stdout.columns, process.stdout.rows) + "\n");
}
