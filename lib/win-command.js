const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function isFile(file) {
  try {
    return fs.existsSync(file) && fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function pathDirs() {
  return (process.env.PATH || "").split(path.delimiter).filter(Boolean);
}

function resolveProgram(name) {
  const raw = String(name || "").trim().replace(/^"+|"+$/g, "");
  if (!raw) return raw;
  if (path.isAbsolute(raw) && isFile(raw) && !/\.ps1$/i.test(raw)) return raw;
  if (process.platform !== "win32") {
    if (isFile(raw)) return path.resolve(raw);
    for (const dir of pathDirs()) {
      const candidate = path.join(dir, raw);
      if (isFile(candidate)) return candidate;
    }
    return raw;
  }
  const exts = path.extname(raw) ? [""] : [".exe", ".cmd", ".bat", ".com"];
  const bases = path.isAbsolute(raw) ? [raw] : pathDirs().map((dir) => path.join(dir, raw));
  for (const base of bases) {
    for (const ext of exts) {
      const candidate = ext ? base + ext : base;
      if (isFile(candidate) && !/\.ps1$/i.test(candidate)) return candidate;
    }
  }
  return raw;
}

function npmShimEntry(text, dir) {
  const key = "node_modules";
  let from = 0;
  while (from < text.length) {
    const idx = text.indexOf(key, from);
    if (idx < 0) return null;
    const quoteAt = text.lastIndexOf('"', idx);
    if (quoteAt < 0) {
      from = idx + key.length;
      continue;
    }
    const rest = text.slice(quoteAt + 1);
    const end = rest.indexOf('"');
    if (end < 0) {
      from = idx + key.length;
      continue;
    }
    const raw = rest
      .slice(0, end)
      .replace(/%dp0%\\/gi, "")
      .replace(/%dp0%\//gi, "")
      .replace(/%~dp0/gi, "")
      .replace(/\//g, "\\");
    const trimmed = raw.replace(/^\\+/, "");
    const candidate = path.isAbsolute(trimmed) ? trimmed : path.join(dir, trimmed);
    if (isFile(candidate)) return candidate;
    from = idx + key.length;
  }
  return null;
}

function unwrapNpmCmd(cmdPath) {
  const ext = path.extname(cmdPath).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return null;
  let text = "";
  try {
    text = fs.readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(cmdPath);
  const entry = npmShimEntry(text, dir);
  if (!entry) return null;
  if (path.extname(entry).toLowerCase() === ".exe") {
    return { command: entry, args: [] };
  }
  const bundled = path.join(dir, "node.exe");
  // resolveProgram returns the name on a miss, so check the hit is real. The
  // bare name is fine either way: spawn resolves it through PATH.
  const onPath = resolveProgram("node");
  const node = isFile(bundled) ? bundled : isFile(onPath) ? onPath : "node";
  return { command: node, args: [entry] };
}

function spawnArgv(command, args) {
  const extra = Array.isArray(args) ? args.slice() : [];
  const resolved = resolveProgram(command);
  const unwrapped = unwrapNpmCmd(resolved);
  if (unwrapped) {
    return {
      command: unwrapped.command,
      args: unwrapped.args.concat(extra),
      resolved,
    };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (process.platform === "win32" && (ext === ".cmd" || ext === ".bat")) {
    // Non-shim batch files: run through cmd via shell: true so Node builds
    // the command line with correct quoting for paths that contain spaces.
    // Manually composing `cmd /s /c` mangles quoted spaced paths.
    return {
      command: resolved,
      args: extra,
      resolved,
      viaCmd: true,
      shell: true,
    };
  }
  return { command: resolved, args: extra, resolved };
}

function spawnHidden(command, args, options) {
  const argv = spawnArgv(command, args);
  return spawn(
    argv.command,
    argv.args,
    Object.assign(
      {
        windowsHide: true,
      },
      argv.shell ? { shell: true } : {},
      options || {},
    ),
  );
}

// child.kill() signals only the direct child. cmd.exe wrappers and adapters
// that spawn their own helpers (codex-acp runs codex app-server) leave a live
// grandchild holding the pipes, so kills go through the process tree.
function killTree(child) {
  if (!child) return;
  const pid = child.pid;
  if (pid && process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" })
        .on("error", () => {})
        .unref();
      return;
    } catch {
      /* fall through to a plain kill */
    }
  }
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      /* not a group leader or already gone */
    }
  }
  try {
    child.kill();
  } catch {
    /* gone */
  }
}

module.exports = {
  isFile,
  resolveProgram,
  unwrapNpmCmd,
  spawnArgv,
  spawnHidden,
  killTree,
};
