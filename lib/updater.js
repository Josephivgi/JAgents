"use strict";

// Updates from GitHub releases. check() asks the GitHub API for the latest
// release of the repo in package.json (with a token from GITHUB_TOKEN /
// GH_TOKEN or the gh CLI when there is one). apply() downloads the release's
// app package (JAgents-<tag>.tar.gz, made by scripts/release.cjs), unpacks it
// over the app folder, and reinstalls packages when they changed. A release
// without that package falls back to a git fast-forward to its tag. The new
// code runs after a restart, which only the user starts.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { findProgram, nodePath } = require("./agents");
const { spawnArgv } = require("./win-command");

function run(program, args, cwd, timeout) {
  return new Promise((resolve, reject) => {
    const argv = spawnArgv(program, args);
    execFile(argv.command, argv.args, { cwd, windowsHide: true, timeout: timeout || 120000, shell: Boolean(argv.shell), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((String(stderr || stdout || "").trim() || err.message).slice(0, 800)));
      resolve(String(stdout || "").trim());
    });
  });
}

// npm through node and npm-cli.js: npm.cmd under "Program Files" breaks
// when it has to go through a shell.
function npmCommand(args) {
  const node = nodePath();
  const cli = node ? path.join(path.dirname(node), "node_modules", "npm", "bin", "npm-cli.js") : "";
  return cli && fs.existsSync(cli) ? [node, [cli].concat(args)] : [findProgram("npm") || "npm", args];
}

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function newer(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// Windows' own tar (bsdtar) unpacks .tar.gz; Git's GNU tar on PATH would read
// "C:" in a path as a remote host, so the archive is always passed relative.
function tarProgram() {
  if (process.platform === "win32") {
    const sys = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sys)) return sys;
  }
  return findProgram("tar") || "tar";
}

function sameFile(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

function repoFromPackage(pkg) {
  const r = pkg.repository;
  const url = typeof r === "string" ? r : r && r.url;
  const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(String(url || ""));
  return m ? m[1] + "/" + m[2] : "";
}

function createUpdater({ appRoot, emit }) {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  const repo = repoFromPackage(pkg);
  let state = { current: pkg.version, repo, latest: "", notes: "", url: repo ? "https://github.com/" + repo + "/releases" : "", publishedAt: "", checkedAt: 0, available: false, checking: false, applying: false, applied: "", error: "", git: fs.existsSync(path.join(appRoot, ".git")) };

  function set(patch) {
    state = Object.assign({}, state, patch);
    if (emit) emit("update-status", state);
    return state;
  }

  async function token() {
    if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const gh = findProgram("gh");
    if (!gh) return "";
    try {
      return await run(gh, ["auth", "token"], appRoot, 15000);
    } catch {
      return "";
    }
  }

  async function check() {
    if (!repo) return set({ error: "package.json has no GitHub repository.", checkedAt: Date.now() });
    set({ checking: true, error: "" });
    try {
      const tok = await token();
      const headers = { Accept: "application/vnd.github+json", "User-Agent": "JAgents/" + pkg.version, "X-GitHub-Api-Version": "2022-11-28" };
      if (tok) headers.Authorization = "Bearer " + tok;
      const res = await fetch("https://api.github.com/repos/" + repo + "/releases/latest", { headers, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) {
        return set({ checking: false, checkedAt: Date.now(), latest: "", available: false, error: tok ? "No releases published yet." : "Cannot see " + repo + ". It is private; sign in with gh auth login, then check again." });
      }
      if (!res.ok) throw new Error("GitHub answered " + res.status + " " + res.statusText);
      const rel = await res.json();
      const latest = String(rel.tag_name || "");
      const asset = (rel.assets || []).find((a) => a.name === "JAgents-" + latest + ".tar.gz");
      return set({ checking: false, checkedAt: Date.now(), latest, notes: String(rel.body || ""), url: rel.html_url || state.url, publishedAt: rel.published_at || "", available: newer(latest, pkg.version), asset: asset ? { url: asset.url, name: asset.name, size: asset.size } : null, error: "" });
    } catch (error) {
      return set({ checking: false, checkedAt: Date.now(), error: "Update check failed: " + String(error.message || error) });
    }
  }

  async function download(asset, file) {
    const tok = await token();
    const headers = { Accept: "application/octet-stream", "User-Agent": "JAgents/" + pkg.version };
    if (tok) headers.Authorization = "Bearer " + tok;
    const res = await fetch(asset.url, { headers, redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!res.ok) throw new Error("Download failed: GitHub answered " + res.status + " " + res.statusText);
    const out = fs.createWriteStream(file);
    let got = 0;
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      set({ step: "Downloading " + (got / 1048576).toFixed(1) + " of " + (asset.size / 1048576).toFixed(1) + " MB" });
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    if (asset.size && fs.statSync(file).size !== asset.size) throw new Error("The download was cut short. Try again.");
  }

  // Download the release package, unpack it to a staging folder, check it is
  // the release it claims to be, then copy it over the app folder.
  async function applyAsset() {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-update-"));
    try {
      const archive = path.join(work, "app.tar.gz");
      await download(state.asset, archive);
      set({ step: "Unpacking" });
      await run(tarProgram(), ["-xzf", "app.tar.gz"], work);
      const staged = path.join(work, "JAgents");
      const next = JSON.parse(fs.readFileSync(path.join(staged, "package.json"), "utf8"));
      if ("v" + next.version !== state.latest) throw new Error("The package is version " + next.version + ", not " + state.latest + ". Nothing was changed.");
      const packagesChanged = !sameFile(path.join(staged, "package.json"), path.join(appRoot, "package.json")) || !sameFile(path.join(staged, "package-lock.json"), path.join(appRoot, "package-lock.json"));
      set({ step: "Copying files" });
      fs.cpSync(staged, appRoot, { recursive: true, force: true });
      if (packagesChanged) {
        set({ step: "Installing packages" });
        const [cmd, args] = npmCommand(["install", "--no-audit", "--no-fund"]);
        await run(cmd, args, appRoot, 600000);
      }
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  async function apply() {
    if (!state.available || !state.latest) throw new Error("There is no newer release to install.");
    if (state.asset) {
      set({ applying: true, error: "", step: "Downloading" });
      try {
        await applyAsset();
        return set({ applying: false, applied: state.latest, step: "" });
      } catch (error) {
        set({ applying: false, step: "", error: String(error.message || error) });
        throw error;
      }
    }
    if (!state.git) throw new Error("This copy of JAgents is not a git checkout, so it cannot update itself. Download the release from " + state.url + ".");
    const git = findProgram("git");
    if (!git) throw new Error("Git is not installed.");
    set({ applying: true, error: "" });
    try {
      const dirty = await run(git, ["status", "--porcelain", "--untracked-files=no"], appRoot);
      if (dirty) throw new Error("The app folder has changes that are not committed. Commit or stash them, then update.\n" + dirty.slice(0, 400));
      const before = await run(git, ["rev-parse", "HEAD"], appRoot);
      await run(git, ["fetch", "--tags", "origin"], appRoot);
      await run(git, ["merge", "--ff-only", "refs/tags/" + state.latest], appRoot);
      const changed = (await run(git, ["diff", "--name-only", before, "HEAD"], appRoot)).split(/\r?\n/);
      if (changed.includes("package.json") || changed.includes("package-lock.json")) {
        const [cmd, args] = npmCommand(["install", "--no-audit", "--no-fund"]);
        await run(cmd, args, appRoot, 600000);
      }
      return set({ applying: false, applied: state.latest });
    } catch (error) {
      set({ applying: false, error: String(error.message || error) });
      throw error;
    }
  }

  return { check, apply, state: () => state };
}

module.exports = { createUpdater, newer };
