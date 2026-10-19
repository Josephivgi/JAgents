const fs = require("fs");
const path = require("path");

function resolveSafe(cwd, filePath) {
  const raw = String(filePath || "");
  if (!raw) throw new Error("path is required");
  const resolved = path.resolve(cwd || process.cwd(), raw);
  return resolved;
}

const READ_MAX = 4 * 1024 * 1024;
const WRITE_MAX = 4 * 1024 * 1024;

// Async with a size cap: a sync read of a FIFO or a huge file would block
// the whole main process behind one agent request.
async function readTextFile(params, cwd) {
  const file = resolveSafe(cwd, params && params.path);
  const stat = await fs.promises.stat(file);
  if (!stat.isFile()) throw new Error("not a regular file");
  const line = params && typeof params.line === "number" && params.line >= 0 ? Math.floor(params.line) : null;
  const limit = params && typeof params.limit === "number" && params.limit >= 0 ? Math.floor(params.limit) : null;
  // A paged read still bounds the response: READ_MAX bytes of whole file is
  // one thing; slicing only needs enough headroom for the requested span.
  if (stat.size > READ_MAX && !(line != null || limit != null)) throw new Error("file is too large to read");
  const content = await fs.promises.readFile(file, "utf8");
  if (line == null && limit == null) return { content };
  // ACP counts lines 1-based; slice [line, line + limit).
  const lines = content.split("\n");
  const start = line == null ? 0 : Math.max(0, line - 1);
  const end = limit == null ? lines.length : start + limit;
  return { content: lines.slice(start, end).join("\n") };
}

async function writeTextFile(params, cwd) {
  const file = resolveSafe(cwd, params && params.path);
  const content = String((params && params.content) || "");
  if (Buffer.byteLength(content, "utf8") > WRITE_MAX) throw new Error("content is too large to write");
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content, "utf8");
  return {};
}

module.exports = { readTextFile, writeTextFile, resolveSafe };
