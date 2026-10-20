"use strict";

// Files attached to a chat message: images, PDFs, code, anything. Each one is
// copied under <data>/attachments/<chatId>/ so the chat keeps it after the
// original moves, and the transcript stores only its name, type, size and
// path. At send time the agent gets real content where it can take it (image
// blocks, embedded text) plus a resource_link and the path, so an agent that
// cannot read a block can still open the file with its own tools.

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const MAX_COUNT = 10;
const MAX_BYTES = 50 * 1024 * 1024;
// Inline limits: bigger files still go as a link and a path.
const IMAGE_INLINE_BYTES = 8 * 1024 * 1024;
const TEXT_INLINE_BYTES = 256 * 1024;
const PDF_INLINE_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".bmp": "image/bmp",
  ".pdf": "application/pdf", ".json": "application/json", ".zip": "application/zip",
  ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".xml": "text/xml",
  ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript", ".ts": "text/x-typescript", ".tsx": "text/x-typescript", ".jsx": "text/javascript",
  ".py": "text/x-python", ".rs": "text/x-rust", ".go": "text/x-go", ".java": "text/x-java", ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".cs": "text/x-csharp",
  ".rb": "text/x-ruby", ".php": "text/x-php", ".sh": "text/x-shellscript", ".ps1": "text/plain", ".bat": "text/plain", ".yml": "text/yaml", ".yaml": "text/yaml",
  ".toml": "text/plain", ".ini": "text/plain", ".log": "text/plain", ".sql": "text/x-sql", ".lua": "text/x-lua", ".luau": "text/x-lua", ".swift": "text/x-swift", ".kt": "text/x-kotlin",
};

function mimeOf(name, given) {
  const g = String(given || "").toLowerCase();
  if (g && g !== "application/octet-stream") return g;
  return MIME[path.extname(String(name || "")).toLowerCase()] || "application/octet-stream";
}

function isImage(a) {
  return IMAGE_TYPES.has(a.mimeType);
}

function isText(a) {
  return /^text\//.test(a.mimeType) || a.mimeType === "application/json";
}

function safeName(name) {
  const base = path.basename(String(name || "file")).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
  return (base || "file").slice(-120);
}

function attachmentsDir(dataRoot, chatId) {
  return path.join(dataRoot, "attachments", String(chatId).replace(/[^\w-]/g, ""));
}

// list: [{name, mimeType, path}] for files on disk (picked or dropped), or
// [{name, mimeType, data}] with base64 for pasted images. Returns transcript
// entries [{name, mimeType, size, path}]. Throws on a file it cannot take.
function saveAttachments(dataRoot, chatId, list) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean);
  if (!items.length) return [];
  if (items.length > MAX_COUNT) throw new Error("Attach up to " + MAX_COUNT + " files per message.");
  const dir = attachmentsDir(dataRoot, chatId);
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (const item of items) {
    // Already saved (a resent message): keep it as it is.
    if (item.path && path.resolve(path.dirname(item.path)) === path.resolve(dir) && fs.existsSync(item.path)) {
      out.push({ name: safeName(item.name || item.path), mimeType: mimeOf(item.name || item.path, item.mimeType), size: fs.statSync(item.path).size, path: item.path });
      continue;
    }
    const name = safeName(item.name || (item.path ? path.basename(item.path) : "pasted.png"));
    const dest = path.join(dir, randomBytes(4).toString("hex") + "-" + name);
    let size;
    if (item.path) {
      const st = fs.statSync(item.path);
      if (!st.isFile()) throw new Error(name + " is a folder. Attach files, or give the agent the folder path in your message.");
      if (st.size > MAX_BYTES) throw new Error(name + " is over 50 MB.");
      fs.copyFileSync(item.path, dest);
      size = st.size;
    } else if (item.data) {
      const raw = String(item.data);
      const buf = Buffer.from(raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw, "base64");
      if (!buf.length) throw new Error(name + " is empty.");
      if (buf.length > MAX_BYTES) throw new Error(name + " is over 50 MB.");
      fs.writeFileSync(dest, buf);
      size = buf.length;
    } else continue;
    out.push({ name, mimeType: mimeOf(name, item.mimeType), size, path: dest });
  }
  return out;
}

function readIf(a, max) {
  try {
    return a.size <= max ? fs.readFileSync(a.path) : null;
  } catch {
    return null;
  }
}

function looksText(buf) {
  return !buf.subarray(0, 8000).includes(0);
}

// One line per file, so every agent knows where its files are.
function attachmentNote(list) {
  if (!list || !list.length) return "";
  return "Attached files (saved on disk; open them with your file tools if you need more than what is shown):\n" + list.map((a) => "- " + a.name + " (" + a.mimeType + ", " + a.size + " bytes): " + a.path).join("\n");
}

// ACP session/prompt blocks. caps is the agent's promptCapabilities.
function acpBlocks(text, list, caps) {
  const c = caps || {};
  const blocks = [{ type: "text", text: [text, attachmentNote(list)].filter(Boolean).join("\n\n") }];
  for (const a of list || []) {
    const uri = pathToFileURL(a.path).href;
    if (isImage(a) && c.image) {
      const buf = readIf(a, IMAGE_INLINE_BYTES);
      if (buf) {
        blocks.push({ type: "image", data: buf.toString("base64"), mimeType: a.mimeType, uri });
        continue;
      }
    }
    if (isText(a) && c.embeddedContext) {
      const buf = readIf(a, TEXT_INLINE_BYTES);
      if (buf && looksText(buf)) {
        blocks.push({ type: "resource", resource: { uri, mimeType: a.mimeType, text: buf.toString("utf8") } });
        continue;
      }
    }
    blocks.push({ type: "resource_link", uri, name: a.name, mimeType: a.mimeType, size: a.size });
  }
  return blocks;
}

// Anthropic message content for the Claude Agent SDK: images and PDFs as
// blocks, text files inline, everything else by path.
function sdkContent(text, list) {
  const out = [{ type: "text", text: [text, attachmentNote(list)].filter(Boolean).join("\n\n") }];
  for (const a of list || []) {
    if (isImage(a)) {
      const buf = readIf(a, IMAGE_INLINE_BYTES);
      if (buf) out.push({ type: "image", source: { type: "base64", media_type: a.mimeType, data: buf.toString("base64") } });
    } else if (a.mimeType === "application/pdf") {
      const buf = readIf(a, PDF_INLINE_BYTES);
      if (buf) out.push({ type: "document", title: a.name, source: { type: "base64", media_type: "application/pdf", data: buf.toString("base64") } });
    } else if (isText(a)) {
      const buf = readIf(a, TEXT_INLINE_BYTES);
      if (buf && looksText(buf)) out.push({ type: "document", title: a.name, source: { type: "text", media_type: "text/plain", data: buf.toString("utf8") } });
    }
  }
  return out;
}

// For history and handoff prompts: names and paths, not contents.
function describeAttachments(list) {
  return (list || []).map((a) => "[attached " + (isImage(a) ? "image" : "file") + ": " + a.name + " at " + a.path + "]").join(" ");
}

module.exports = { saveAttachments, acpBlocks, sdkContent, describeAttachments, attachmentsDir, isImage, mimeOf, MAX_COUNT, MAX_BYTES };
