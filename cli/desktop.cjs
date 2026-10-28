"use strict";

// The JAgents desktop app, seen from the terminal app: where it is, which
// version is installed, opening it on a folder, and installing the latest
// public release straight from GitHub.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { spawn, execFileSync } = require("node:child_process");

const APP_ROOT = path.join(__dirname, "..");
const REPO = "Josephivgi/JAgents";
const RELEASE_API = "https://api.github.com/repos/" + REPO + "/releases/latest";
const SETUP_NAME = "JAgents-Setup.exe";
const SETUP_URL = "https://github.com/" + REPO + "/releases/latest/download/" + SETUP_NAME;
const UNINSTALL_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\JAgents";
const SETUP_EXE = path.join(process.env.LOCALAPPDATA || "", "Programs", "JAgents", "JAgents.exe");

// Installed (the CLI zip): <install>\JAgents.exe with this file in
// resources\app\cli. From a checkout: the electron package's runtime. Last,
// the per-user install from JAgents-Setup.exe.
function desktopCommand(cwd) {
  const installed = path.resolve(APP_ROOT, "..", "..", "JAgents.exe");
  if (fs.existsSync(installed)) return { command: installed, args: ["--project=" + cwd] };
  try {
    const electron = require(path.join(APP_ROOT, "node_modules", "electron"));
    if (typeof electron === "string" && fs.existsSync(electron)) return { command: electron, args: [APP_ROOT, "--project=" + cwd] };
  } catch {
    /* no runtime */
  }
  if (process.env.LOCALAPPDATA && fs.existsSync(SETUP_EXE)) return { command: SETUP_EXE, args: ["--project=" + cwd] };
  return null;
}

// Calls done("") once the app is up (or was already running and took the
// request), or done(message) when it could not start.
function openDesktop(cwd, done) {
  const cmd = desktopCommand(cwd);
  if (!cmd) return done("JAgents Desktop is not installed. Run jagents install-desktop.");
  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) if (/^ELECTRON_/.test(k)) delete env[k];
  let settled = false;
  const finish = (msg) => {
    if (settled) return;
    settled = true;
    done(msg);
  };
  try {
    const child = spawn(cmd.command, cmd.args, { cwd: APP_ROOT, env, detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (error) => finish("Could not open the desktop app: " + (error.message || error)));
    // A second launch hands its folder to the running window and exits 0.
    child.on("exit", (code) => finish(code ? "The desktop app exited with code " + code + "." : ""));
    child.unref();
    setTimeout(() => finish(""), 2500);
  } catch (error) {
    finish("Could not open the desktop app: " + (error.message || error));
  }
}

// Version the setup wrote to Add or Remove Programs, or "" when not installed.
function desktopVersion() {
  if (process.platform !== "win32") return "";
  try {
    const outText = execFileSync("reg", ["query", UNINSTALL_KEY, "/v", "DisplayVersion"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const m = /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(outText);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// True when the setup's copy is on disk, with or without its registry entry.
function desktopSetupInstalled() {
  return Boolean(desktopVersion()) || Boolean(process.env.LOCALAPPDATA && fs.existsSync(SETUP_EXE));
}

function get(url, onResponse, done, hops) {
  const req = https.get(url, { headers: { "User-Agent": "jagents-cli", Accept: "application/vnd.github+json" } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if ((hops || 0) > 5) return done(new Error("Too many redirects."));
      return get(new URL(res.headers.location, url).toString(), onResponse, done, (hops || 0) + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return done(new Error("GitHub answered " + res.statusCode + " for " + url));
    }
    onResponse(res);
  });
  req.on("error", done);
  req.setTimeout(60000, () => req.destroy(new Error("GitHub did not answer.")));
}

// The latest public release (GitHub leaves out drafts and pre-releases):
// done(null, {tag, url}). If the API is out of reach (rate limit), the
// release's fixed download link still works, with the tag unknown.
function latestRelease(done) {
  get(
    RELEASE_API,
    (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => {
        try {
          const release = JSON.parse(body);
          const asset = (release.assets || []).find((a) => a.name === SETUP_NAME);
          if (!asset) return done(new Error("The latest release (" + release.tag_name + ") has no " + SETUP_NAME + "."));
          done(null, { tag: release.tag_name, url: asset.browser_download_url });
        } catch (error) {
          done(error);
        }
      });
      res.on("error", done);
    },
    (err) => done(null, { tag: "", url: SETUP_URL, apiError: err }),
  );
}

function download(url, file, onProgress, done) {
  get(
    url,
    (res) => {
      const total = Number(res.headers["content-length"]) || 0;
      let got = 0;
      const outFile = fs.createWriteStream(file);
      res.on("data", (chunk) => {
        got += chunk.length;
        onProgress(got, total);
      });
      res.pipe(outFile);
      outFile.on("finish", () => outFile.close(() => done(null)));
      outFile.on("error", done);
      res.on("error", done);
    },
    done,
  );
}

// Downloads the latest release's setup from GitHub and runs it silently. It
// installs per user (no admin) to %LOCALAPPDATA%\Programs\JAgents, replacing
// any copy already there, and opens the app when done.
// JAGENTS_SETUP_ARGS adds setup arguments (tests use /TESTDIR=<folder>).
// onStep(text, pct) reports progress; done(err, {version, tag}).
function installDesktop(onStep, done) {
  if (process.platform !== "win32") return done(new Error("The desktop setup is for Windows. Other systems run it from source: see github.com/" + REPO + "."));
  onStep("Finding the latest JAgents Desktop release…", -1);
  latestRelease((err, release) => {
    if (err) return done(err);
    const name = "JAgents Desktop" + (release.tag ? " " + release.tag : "");
    const file = path.join(os.tmpdir(), "JAgents-Setup-" + process.pid + "-" + Date.now() + ".exe");
    let lastPct = -2;
    onStep("Downloading " + name + " from GitHub…", 0);
    download(
      release.url,
      file,
      (got, total) => {
        const pct = total ? Math.floor((got / total) * 100) : -1;
        if (pct === lastPct) return;
        lastPct = pct;
        const mb = (n) => (n / 1048576).toFixed(0);
        onStep("Downloading " + name + " " + (total ? pct + "% (" + mb(got) + " of " + mb(total) + " MB)" : mb(got) + " MB"), pct);
      },
      (dlErr) => {
        if (dlErr) {
          fs.rm(file, { force: true }, () => {});
          return done(dlErr);
        }
        onStep("Installing " + name + "…", 100);
        const extra = (process.env.JAGENTS_SETUP_ARGS || "").split(" ").filter(Boolean);
        const child = spawn(file, ["/S"].concat(extra), { stdio: "ignore", windowsHide: true });
        child.on("error", done);
        child.on("exit", (code) => {
          fs.rm(file, { force: true }, () => {});
          if (code) return done(new Error(code === 1 ? "Setup stopped because JAgents Desktop is open. Close it and try again." : "Setup exited with code " + code + "."));
          done(null, { version: desktopVersion(), tag: release.tag });
        });
      },
    );
  });
}

// "0.5.2" and "v0.5.2" are the same version.
function sameVersion(a, b) {
  const clean = (v) => String(v || "").replace(/^v/i, "");
  return Boolean(a && b) && clean(a) === clean(b);
}

module.exports = { REPO, desktopCommand, openDesktop, desktopVersion, desktopSetupInstalled, latestRelease, installDesktop, sameVersion, get, download };
