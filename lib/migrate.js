"use strict";

// Bringing Relay ADE data into JAgents. Relay started from inside the Claude
// desktop app keeps its data in that app's package folder
// (%LOCALAPPDATA%\Packages\<app>\LocalCache\Roaming\Relay ADE), which a JAgents
// started on its own cannot see under %APPDATA%, so every candidate is checked
// and the most recently used one wins.
//
// The import runs when the user asks for it (MCP hub > Legacy), at the next
// startup, before the database opens. It merges into an existing jagents.db: Relay's settings
// (layout, handles, hub switch, plugin state) and threads replace JAgents'
// fresh ones, and plugin, plugin-data and handoff folders are copied without
// overwriting. The Relay folder is only read.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FOLDERS = ["plugins", "plugin-data", "handoffs"];

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// Every Relay ADE data folder on this computer, most recently used first.
function findLegacyRoots(appData) {
  const out = new Set();
  if (appData) out.add(path.join(appData, "Relay ADE"));
  if (process.env.APPDATA) out.add(path.join(process.env.APPDATA, "Relay ADE"));
  const packages = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Packages");
  let names = [];
  try {
    names = fs.readdirSync(packages);
  } catch {
    /* not Windows, or no packaged apps */
  }
  for (const name of names) out.add(path.join(packages, name, "LocalCache", "Roaming", "Relay ADE"));
  const used = (root) => Math.max(mtime(path.join(root, "relay.db")), mtime(path.join(root, "relay.db-wal")));
  return [...out].filter((root) => fs.existsSync(path.join(root, "relay.db"))).sort((a, b) => used(b) - used(a));
}

// Relay writes its pid into ~/.relay-ade/hub.json while it runs.
function relayRunning(homeDir) {
  try {
    const hub = JSON.parse(fs.readFileSync(path.join(homeDir || os.homedir(), ".relay-ade", "hub.json"), "utf8"));
    if (!hub.pid) return false;
    process.kill(hub.pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function copyFolders(oldRoot, newRoot) {
  for (const name of FOLDERS) {
    const src = path.join(oldRoot, name);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(newRoot, name);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      const to = path.join(dest, entry);
      if (!fs.existsSync(to)) fs.cpSync(path.join(src, entry), to, { recursive: true });
    }
  }
}

function rows(db, table) {
  try {
    return db.prepare("SELECT * FROM " + table).all();
  } catch {
    return [];
  }
}

// Merge oldRoot/relay.db into newRoot/jagents.db (created by VACUUM INTO when
// it does not exist yet). Returns { threads, settings, from }.
function importLegacy(oldRoot, newRoot) {
  const { DatabaseSync } = require("node:sqlite");
  const oldDb = path.join(oldRoot, "relay.db");
  const newDb = path.join(newRoot, "jagents.db");
  fs.mkdirSync(newRoot, { recursive: true });
  copyFolders(oldRoot, newRoot);
  const src = new DatabaseSync(oldDb, { readOnly: true });
  try {
    if (!fs.existsSync(newDb)) {
      src.exec("VACUUM INTO '" + newDb.replace(/'/g, "''") + "'");
      const dst = new DatabaseSync(newDb);
      try {
        mark(dst, oldRoot);
      } finally {
        dst.close();
      }
      return { threads: rows(src, "chats").length, settings: rows(src, "settings").length, from: oldRoot };
    }
    const settings = rows(src, "settings");
    const chats = rows(src, "chats");
    const dst = new DatabaseSync(newDb, { timeout: 5000 });
    try {
      dst.exec("BEGIN");
      const putSetting = dst.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)");
      for (const r of settings) putSetting.run(r.key, r.value_json);
      if (chats.length) {
        const cols = Object.keys(chats[0]);
        const putChat = dst.prepare("INSERT OR REPLACE INTO chats (" + cols.join(", ") + ") VALUES (" + cols.map(() => "?").join(", ") + ")");
        for (const r of chats) putChat.run(...cols.map((c) => r[c]));
      }
      mark(dst, oldRoot);
      dst.exec("COMMIT");
    } catch (error) {
      try {
        dst.exec("ROLLBACK");
      } catch {
        /* nothing to undo */
      }
      throw error;
    } finally {
      dst.close();
    }
    return { threads: chats.length, settings: settings.length, from: oldRoot };
  } finally {
    src.close();
  }
}

function mark(db, from) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value_json) VALUES (?, ?)").run("legacy.imported", JSON.stringify({ from, at: new Date().toISOString() }));
}

module.exports = { findLegacyRoots, relayRunning, importLegacy };
