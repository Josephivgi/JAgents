"use strict";

// Installs a marketplace agent the way the ACP Registry describes it:
//  - binary: download the archive for this platform, check its sha256, unpack
//    it into the agent's folder under the data root.
//  - npm: npm install into the agent's own folder (no global install), then
//    run the package's bin.
//  - uv: uv tool install, then run it through uv tool run.
//  - script: a built-in's official install script (Claude Code).
// Progress lines stream to onLine. Resolves with the spawn spec to save.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { spawnHidden, killTree, isFile } = require("./win-command");
const { findProgram, LOCAL_BIN, clearResolveCache } = require("./agents");

const STEP_MS = 10 * 60 * 1000;

// Strips ANSI color codes and progress spinners down to readable lines.
function cleanLines(text) {
  return String(text)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter(Boolean);
}

function run(child, onLine) {
  return new Promise((resolve, reject) => {
    const tail = [];
    const take = (chunk) => {
      for (const line of cleanLines(chunk)) {
        tail.push(line);
        if (tail.length > 20) tail.shift();
        onLine(line);
      }
    };
    if (child.stdout) child.stdout.on("data", take);
    if (child.stderr) child.stderr.on("data", take);
    const timer = setTimeout(() => {
      take("This step took longer than 10 minutes and was stopped.");
      killTree(child);
    }, STEP_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Exited with code " + code + (tail.length ? ": " + tail.slice(-3).join(" ") : "")));
    });
  });
}

// npm.cmd is not a plain npm shim, and cmd.exe mangles its quoted Program
// Files path; run npm-cli.js with the node next to it instead.
function npmChild(args, cwd) {
  const npm = findProgram("npm");
  if (!npm) throw new Error("npm was not found. Install Node.js from nodejs.org, then try again.");
  const dir = path.dirname(npm);
  const cli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  const node = path.join(dir, process.platform === "win32" ? "node.exe" : "node");
  if (isFile(cli) && isFile(node)) return spawn(node, [cli].concat(args), { cwd, windowsHide: true });
  return spawnHidden(npm, args, { cwd });
}

function uvPath() {
  const uv = findProgram("uv", [LOCAL_BIN, path.join(os.homedir(), ".cargo", "bin")]);
  if (!uv) throw new Error("uv was not found. Install it from docs.astral.sh/uv, then try again.");
  return uv;
}

// "@scope/name@1.2.3" -> "@scope/name"
function packageName(spec) {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function freshDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

async function installNpm(plan, onLine) {
  freshDir(plan.dir);
  fs.writeFileSync(path.join(plan.dir, "package.json"), JSON.stringify({ name: "jagents-agent", private: true }));
  onLine("npm install " + plan.dist.pkg);
  await run(npmChild(["install", "--no-audit", "--no-fund", "--omit=dev", plan.dist.pkg], plan.dir), onLine);
  const name = packageName(plan.dist.pkg);
  const meta = JSON.parse(fs.readFileSync(path.join(plan.dir, "node_modules", name, "package.json"), "utf8"));
  const bins = typeof meta.bin === "string" ? { [name.replace(/^@[^/]+\//, "")]: meta.bin } : meta.bin || {};
  const names = Object.keys(bins);
  if (!names.length) throw new Error(name + " has no program to run.");
  const base = name.replace(/^@[^/]+\//, "");
  const bin = names.length === 1 ? names[0] : names.find((n) => n === base) || names.find((n) => /acp/i.test(n)) || names[0];
  // The .bin shim is what npx would run; spawnArgv unwraps it to node + script.
  const shim = path.join(plan.dir, "node_modules", ".bin", bin + (process.platform === "win32" ? ".cmd" : ""));
  if (!isFile(shim)) throw new Error("npm did not create the " + bin + " program.");
  return { command: shim, args: plan.dist.args.slice(), env: plan.dist.env };
}

async function installUv(plan, onLine) {
  const uv = uvPath();
  onLine("uv tool install " + plan.dist.pkg);
  await run(spawnHidden(uv, ["tool", "install", "--force", plan.dist.pkg]), onLine);
  return { command: uv, args: ["tool", "run", plan.dist.pkg].concat(plan.dist.args), env: plan.dist.env };
}

async function download(url, file, onLine) {
  onLine("Downloading " + url.replace(/^.*\//, ""));
  const res = await fetch(url, { signal: AbortSignal.timeout(STEP_MS), headers: { "user-agent": "JAgents" } });
  if (!res.ok || !res.body) throw new Error("Download failed: HTTP " + res.status);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  const out = fs.createWriteStream(file);
  let got = 0;
  let shown = 0;
  for await (const chunk of res.body) {
    hash.update(chunk);
    got += chunk.length;
    if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
    if (got - shown > 4 * 1024 * 1024) {
      shown = got;
      onLine("Downloaded " + Math.round(got / 1048576) + (total ? " of " + Math.round(total / 1048576) : "") + " MB");
    }
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  return hash.digest("hex");
}

async function installBinary(plan, onLine) {
  const d = plan.dist;
  freshDir(plan.dir);
  const name = decodeURIComponent(d.archive.replace(/[?#].*$/, "").replace(/^.*\//, ""));
  const file = path.join(plan.dir, name);
  const digest = await download(d.archive, file, onLine);
  if (d.sha256 && digest.toLowerCase() !== d.sha256.toLowerCase()) {
    fs.rmSync(file, { force: true });
    throw new Error("The download did not match the registry checksum, so it was deleted.");
  }
  if (/\.(zip|tar\.gz|tgz|tar\.xz|tar\.bz2|tar)$/i.test(name)) {
    onLine("Unpacking " + name);
    // tar.exe (bsdtar) ships with Windows 10 and later and reads zip too.
    const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
    await run(spawn(tar, ["-xf", name], { cwd: plan.dir, windowsHide: true }), onLine);
    fs.rmSync(file, { force: true });
  }
  const command = path.resolve(plan.dir, d.cmd.replace(/[\\/]/g, path.sep));
  if (!command.startsWith(path.resolve(plan.dir) + path.sep)) throw new Error("The registry entry points outside its folder.");
  if (!isFile(command)) throw new Error("The download does not contain " + d.cmd + ".");
  if (process.platform !== "win32") fs.chmodSync(command, 0o755);
  return { command, args: d.args.slice(), env: d.env };
}

async function installScript(plan, onLine) {
  const d = plan.dist;
  onLine(process.platform === "win32" ? d.ps : d.sh);
  const child = process.platform === "win32" ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", d.ps], { windowsHide: true }) : spawn("bash", ["-lc", d.sh]);
  await run(child, onLine);
  return null;
}

async function installAgent(plan, onLine) {
  const say = typeof onLine === "function" ? onLine : () => {};
  try {
    if (plan.dist.kind === "npm") return await installNpm(plan, say);
    if (plan.dist.kind === "uv") return await installUv(plan, say);
    if (plan.dist.kind === "binary") return await installBinary(plan, say);
    if (plan.dist.kind === "script") return await installScript(plan, say);
    throw new Error("Unknown install kind " + plan.dist.kind);
  } finally {
    clearResolveCache();
  }
}

module.exports = { installAgent, packageName };
