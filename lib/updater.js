"use strict";

// Updates from GitHub releases. check() asks the GitHub API for the latest
// release of the repo in package.json; the repo is private for now, so it
// sends a token from GITHUB_TOKEN / GH_TOKEN or the signed-in gh CLI. apply()
// works when the app runs from a git checkout: it fast-forwards to the
// release tag and reinstalls packages when they changed. The new code runs
// after a restart, which only the user starts.

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { findProgram } = require("./agents");
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
      return set({ checking: false, checkedAt: Date.now(), latest, notes: String(rel.body || ""), url: rel.html_url || state.url, publishedAt: rel.published_at || "", available: newer(latest, pkg.version), error: "" });
    } catch (error) {
      return set({ checking: false, checkedAt: Date.now(), error: "Update check failed: " + String(error.message || error) });
    }
  }

  async function apply() {
    if (!state.available || !state.latest) throw new Error("There is no newer release to install.");
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
      if (changed.includes("package.json") || changed.includes("package-lock.json")) await run(findProgram("npm") || "npm", ["install", "--no-audit", "--no-fund"], appRoot, 600000);
      return set({ applying: false, applied: state.latest });
    } catch (error) {
      set({ applying: false, error: String(error.message || error) });
      throw error;
    }
  }

  return { check, apply, state: () => state };
}

module.exports = { createUpdater, newer };
