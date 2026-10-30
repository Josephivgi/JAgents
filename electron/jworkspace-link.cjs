"use strict";

// JWorkspace, the JSystems app that hosts every JSystems app, ships an MCP
// server (jworkspace) that lets agents make and test JWorkspace plugins. When
// JWorkspace is on this computer, JAgents gives that server to every agent it
// starts. Nothing here needs JWorkspace to exist: with no JWorkspace folder,
// detect() says so and agents get no extra server.
//
// What JWorkspace leaves in its home folder (%APPDATA%\JWorkspace, or
// JWORKSPACE_HOME):
//   mcp/mcp/jworkspace-mcp.cjs  the server, copied there each time JWorkspace starts
//   mcp/app.json                { appRoot, electron, version }
//   control.json                { pipe, token, pid } while JWorkspace runs
// The server finds control.json itself from JWORKSPACE_HOME. Tools that need
// the running app say so when it is closed.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const NAME = "jworkspace";

function defaultHome(env) {
  const e = env || process.env;
  if (e.JWORKSPACE_HOME) return path.resolve(e.JWORKSPACE_HOME);
  const base = e.APPDATA || (process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : e.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"));
  return path.join(base, "JWorkspace");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// { found, running, version, home, script }. found: the server is there to
// run. running: JWorkspace is open right now.
function detect(opts) {
  const home = (opts && opts.home) || defaultHome(opts && opts.env);
  const script = path.join(home, "mcp", "mcp", "jworkspace-mcp.cjs");
  const found = fs.existsSync(script);
  const app = (found && readJson(path.join(home, "mcp", "app.json"))) || {};
  const control = readJson(path.join(home, "control.json")) || {};
  return {
    found,
    running: found && alive(Number(control.pid)),
    version: typeof app.version === "string" ? app.version : "",
    home,
    script,
    electron: typeof app.electron === "string" && app.electron && fs.existsSync(app.electron) ? app.electron : "",
  };
}

// The server as an MCP stdio entry in ACP's {name, command, args, env[]}
// shape, or null when JWorkspace is not on this computer. It runs on
// JWorkspace's own Electron as Node (the runtime it is made for), else on
// JAgents' Electron.
function mcpEntry(opts) {
  const d = detect(opts);
  if (!d.found) return null;
  return {
    name: NAME,
    command: d.electron || process.execPath,
    args: [d.script],
    env: [
      { name: "ELECTRON_RUN_AS_NODE", value: "1" },
      { name: "JWORKSPACE_HOME", value: d.home },
    ],
  };
}

module.exports = { NAME, defaultHome, detect, mcpEntry };
