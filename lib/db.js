"use strict";

// One SQLite file (relay.db) in the data root: app settings, the pane layout,
// and ACP chat threads with their transcripts. Adapted from Plugin App's db.js.
// Only the main process opens it.

const fs = require("node:fs");
const path = require("node:path");
const { handoffRow } = require("./acp-handoff");

let DatabaseSync = null;
function ctor() {
  if (!DatabaseSync) ({ DatabaseSync } = require("node:sqlite"));
  return DatabaseSync;
}

const BUSY_MS = 5000;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, harness_id TEXT NOT NULL, acp_session_id TEXT NOT NULL DEFAULT '', transcript_json TEXT NOT NULL DEFAULT '[]', cwd TEXT NOT NULL DEFAULT '', parent_id TEXT NOT NULL DEFAULT '', handle TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
];

function openDb(dataRoot) {
  if (!dataRoot) throw new Error("dataRoot is required");
  fs.mkdirSync(dataRoot, { recursive: true });
  const db = new (ctor())(path.join(dataRoot, "relay.db"), { timeout: BUSY_MS });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=" + BUSY_MS);
  for (const sql of SCHEMA) db.exec(sql);
  return createStore(db);
}

function now() {
  return new Date().toISOString();
}

function parse(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function transcriptTailAt(rows) {
  const list = Array.isArray(rows) ? rows : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const at = list[i] && list[i].at;
    if (Number.isFinite(at)) return at;
  }
  return 0;
}

function rowToChat(row, withTranscript) {
  const chat = {
    id: row.id,
    title: row.title,
    harnessId: row.harness_id,
    acpSessionId: row.acp_session_id,
    cwd: row.cwd,
    parentId: row.parent_id,
    handle: row.handle,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (withTranscript) chat.transcript = parse(row.transcript_json, []);
  return chat;
}

function createStore(db) {
  const q = {
    getSetting: db.prepare("SELECT value_json FROM settings WHERE key = ?"),
    setSetting: db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"),
    chats: db.prepare("SELECT id, title, harness_id, acp_session_id, cwd, parent_id, handle, created_at, updated_at FROM chats ORDER BY updated_at DESC"),
    chat: db.prepare("SELECT * FROM chats WHERE id = ?"),
    chatHarness: db.prepare("SELECT harness_id FROM chats WHERE id = ?"),
    insertChat: db.prepare("INSERT INTO chats (id, title, harness_id, acp_session_id, transcript_json, cwd, parent_id, handle, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?)"),
    saveChat: db.prepare("UPDATE chats SET title = ?, harness_id = ?, acp_session_id = ?, transcript_json = ?, updated_at = ? WHERE id = ?"),
    switchChat: db.prepare("UPDATE chats SET harness_id = ?, acp_session_id = '', transcript_json = ?, updated_at = ? WHERE id = ?"),
    deleteChat: db.prepare("DELETE FROM chats WHERE id = ?"),
  };

  return {
    close: () => db.close(),
    getSetting(key, fallback) {
      const row = q.getSetting.get(String(key));
      return row ? parse(row.value_json, fallback) : fallback;
    },
    setSetting(key, value) {
      q.setSetting.run(String(key), JSON.stringify(value));
      return value;
    },
    listChats: () => q.chats.all().map((row) => rowToChat(row, false)),
    getChat(id) {
      const row = q.chat.get(String(id));
      return row ? rowToChat(row, true) : null;
    },
    createChat(input) {
      const src = input || {};
      const at = now();
      q.insertChat.run(String(src.id), String(src.title || "New thread"), String(src.harnessId || "devin"), JSON.stringify(src.transcript || []), String(src.cwd || ""), String(src.parentId || ""), String(src.handle || ""), at, at);
      return this.getChat(src.id);
    },
    saveChat(chat, options) {
      const forHarness = String((options && options.forHarness) || "");
      // A chat handed to another agent must not be overwritten by the old
      // session's debounced save.
      if (forHarness) {
        const row = q.chatHarness.get(String(chat.id));
        if (!row || String(row.harness_id || "") !== forHarness) return false;
      }
      q.saveChat.run(String(chat.title), String(chat.harnessId), String(chat.acpSessionId || ""), JSON.stringify(chat.transcript || []), now(), String(chat.id));
      return true;
    },
    // The one way to rebind an agent-locked chat: a context handoff.
    switchChatHarness(id, input) {
      const key = String(id || "");
      const src = input || {};
      const next = String(src.harnessId || "").trim();
      if (!next) throw new Error("harnessId is required");
      const row = q.chat.get(key);
      if (!row) throw new Error("Chat not found.");
      const from = String(row.harness_id || "");
      if (from === next) return this.getChat(key);
      let rows = parse(row.transcript_json, []);
      if (!Array.isArray(rows)) rows = [];
      const live = (Array.isArray(src.liveTranscript) ? src.liveTranscript : []).filter((r) => r && typeof r === "object");
      if (live.length && transcriptTailAt(live) >= transcriptTailAt(rows)) rows = live.slice();
      if (rows.length) rows.push(handoffRow({ from, to: next, fromName: src.fromName, toName: src.toName, at: Math.max(Date.now(), transcriptTailAt(rows) + 1) }));
      q.switchChat.run(next, JSON.stringify(rows), now(), key);
      return this.getChat(key);
    },
    deleteChat: (id) => Number(q.deleteChat.run(String(id)).changes) > 0,
  };
}

module.exports = { openDb };
