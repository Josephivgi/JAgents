"use strict";

// One-time copy from the old Relay ADE data folder to the JAgents one. The old
// folder is only read, never changed. The database goes through VACUUM INTO,
// which gives a consistent copy even while an older Relay still has it open.

const fs = require("node:fs");
const path = require("node:path");

const KEEP = ["plugins", "plugin-data", "handoffs"];

function migrateLegacyData(oldRoot, newRoot) {
  const oldDb = path.join(oldRoot, "relay.db");
  const newDb = path.join(newRoot, "jagents.db");
  if (fs.existsSync(newDb) || !fs.existsSync(oldDb)) return false;
  fs.mkdirSync(newRoot, { recursive: true });
  for (const name of KEEP) {
    const src = path.join(oldRoot, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(newRoot, name), { recursive: true, force: false });
  }
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(oldDb, { readOnly: true });
  try {
    db.exec("VACUUM INTO '" + newDb.replace(/'/g, "''") + "'");
  } finally {
    db.close();
  }
  return true;
}

module.exports = { migrateLegacyData };
