"use strict";

// Files in a chat's folder for the composer's @ menu. A git checkout lists
// what git tracks plus untracked files it does not ignore; other folders are
// walked, skipping dependency and build folders. Lists are cached briefly per
// folder so typing does not rescan.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MAX_FILES = 20000;
const CACHE_MS = 30000;
const SKIP = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out", ".next", "target", ".cache", ".idea", ".vs"]);
const cache = new Map(); // cwd -> {at, files}

function gitFiles(cwd) {
  return new Promise((resolve) => {
    execFile("git", ["ls-files", "-co", "--exclude-standard"], { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 8000 }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(String(stdout).split(/\r?\n/).filter(Boolean).slice(0, MAX_FILES));
    });
  });
}

function walk(cwd) {
  const out = [];
  const stack = [""];
  while (stack.length && out.length < MAX_FILES) {
    const rel = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(cwd, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) stack.push(child);
      } else if (e.isFile()) out.push(child);
      if (out.length >= MAX_FILES) break;
    }
  }
  return out;
}

async function listFiles(cwd) {
  const hit = cache.get(cwd);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.files;
  const files = (await gitFiles(cwd)) || walk(cwd);
  cache.set(cwd, { at: Date.now(), files });
  return files;
}

// Best matches first: file name starts with the query, then contains it, then
// the path contains it, then the letters appear in order.
function rank(file, q) {
  const f = file.toLowerCase();
  const base = f.slice(f.lastIndexOf("/") + 1);
  if (!q) return 3;
  if (base.startsWith(q)) return 0;
  if (base.includes(q)) return 1;
  if (f.includes(q)) return 2;
  let i = 0;
  for (const ch of f) if (ch === q[i]) i++;
  return i === q.length ? 3 : -1;
}

async function searchFiles(cwd, query, limit) {
  if (!cwd || !fs.existsSync(cwd)) return [];
  const q = String(query || "").toLowerCase().replace(/\\/g, "/");
  const files = await listFiles(cwd);
  const scored = [];
  for (const file of files) {
    const r = rank(file, q);
    if (r >= 0) scored.push({ file, r });
  }
  scored.sort((a, b) => a.r - b.r || a.file.length - b.file.length || a.file.localeCompare(b.file));
  return scored.slice(0, limit || 30).map((x) => x.file);
}

module.exports = { searchFiles };
