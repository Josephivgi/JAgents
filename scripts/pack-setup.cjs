#!/usr/bin/env node
"use strict";

// Builds dist/JAgents-Setup.exe, the Windows setup a person downloads and
// double-clicks. The name never changes, so
// releases/latest/download/JAgents-Setup.exe always serves the newest one.
//   node scripts/pack-setup.cjs [tag]      (default v<package.json version>)
// .github/workflows/setup.yml runs it for every published release and
// attaches the setup to it.
//
// The staged layout is the Electron runtime renamed to JAgents.exe with the
// tagged source (the same files as JAgents-<tag>.tar.gz) and its production
// packages in resources\app. The updater rewrites that folder in place, so an
// installed copy takes later releases like a checkout does.
// scripts/installer.nsi puts it in %LOCALAPPDATA%\Programs\JAgents (no admin)
// with shortcuts and an uninstall entry.
//
// Needs the Windows Electron runtime (npm install on Windows), npm, and NSIS
// (makensis on PATH, in Program Files, MAKENSIS=<path>, or a portable
// %LOCALAPPDATA%\nsis-* folder).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { applyIcon } = require("./icon-resource.cjs");

const root = path.join(__dirname, "..");
const SETUP_NAME = "JAgents-Setup.exe";

function findMakensis(env) {
  const candidates = [];
  if (env.MAKENSIS) candidates.push(env.MAKENSIS);
  for (const dir of String(env.PATH || "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, "makensis.exe"));
  for (const base of [env["ProgramFiles(x86)"], env.ProgramFiles]) if (base) candidates.push(path.join(base, "NSIS", "makensis.exe"));
  if (env.LOCALAPPDATA) {
    try {
      for (const name of fs.readdirSync(env.LOCALAPPDATA).filter((n) => /^nsis-/i.test(n)).sort().reverse()) candidates.push(path.join(env.LOCALAPPDATA, name, "makensis.exe"));
    } catch {}
  }
  return candidates.find((file) => fs.existsSync(file)) || "";
}

// Windows file versions are four numbers: 0.3.0 -> 0.3.0.0.
function fileVersion(version) {
  const nums = String(version).split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  while (nums.length < 4) nums.push(0);
  return nums.slice(0, 4).join(".");
}

// Installed size in KB for the Add-or-Remove-Programs entry, measured here so
// the setup does not have to count thousands of files on the user's PC.
function dirSizeKB(dir) {
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) bytes += fs.statSync(full).size;
    }
  };
  walk(dir);
  return Math.ceil(bytes / 1024);
}

// Type declarations and source maps are never loaded at runtime but were about
// 40% of the files in node_modules, and each file costs the setup time to
// write and Windows Defender time to scan.
function pruneForSetup(dir) {
  let removed = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.d\.[cm]?ts$|\.map$/.test(entry.name)) { fs.rmSync(full); removed += 1; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return removed;
}

function buildSetup(tagArg) {
  const tag = tagArg || "v" + JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const makensis = findMakensis(process.env);
  if (!makensis) throw new Error("makensis (NSIS) not found.");
  const runtime = path.join(root, "node_modules", "electron", "dist");
  if (!fs.existsSync(path.join(runtime, "electron.exe"))) throw new Error("No Windows Electron runtime in node_modules/electron/dist. Run npm install on Windows.");
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd: cwd || root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  run("git", ["rev-parse", "--verify", "refs/tags/" + tag]);
  const version = JSON.parse(run("git", ["show", tag + ":package.json"])).version;

  // Each step prints when it starts and how long it took, so a build in a
  // terminal or the Actions log shows where it is.
  const started = Date.now();
  const STEPS = 6;
  let stepNo = 0;
  const step = (label, fn) => {
    stepNo += 1;
    const t0 = Date.now();
    process.stdout.write("[" + stepNo + "/" + STEPS + "] " + label + "...");
    const result = fn();
    console.log(" " + ((Date.now() - t0) / 1000).toFixed(1) + "s");
    return result;
  };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-setup-"));
  try {
    const stage = path.join(work, "JAgents");
    const app = path.join(stage, "resources", "app");
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const tarCmd = fs.existsSync(tar) ? tar : "tar";
    step("Copying the Electron runtime", () => {
      fs.cpSync(runtime, stage, { recursive: true });
      fs.renameSync(path.join(stage, "electron.exe"), path.join(stage, "JAgents.exe"));
      fs.rmSync(path.join(stage, "resources", "default_app.asar"), { force: true });
    });

    // The tagged source, unpacked with Windows' own tar (see lib/updater.js).
    step("Exporting " + tag + " source", () => {
      run("git", ["archive", "--format=tar", "--prefix=app/", "-o", path.join(work, "app.tar"), tag]);
      run(tarCmd, ["-xf", "../../app.tar"], path.join(stage, "resources"));
    });
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const npm = fs.existsSync(npmCli) ? [process.execPath, [npmCli]] : ["npm", []];
    step("Installing production packages (npm ci)", () => {
      run(npm[0], npm[1].concat(["ci", "--omit=dev", "--no-audit", "--no-fund"]), app);
      pruneForSetup(path.join(app, "node_modules"));
    });

    step("Setting the app icon", () => {
      const icon = applyIcon(path.join(stage, "JAgents.exe"), path.join(app, "build", "icon.ico"));
      if (!icon.ok) throw new Error("The app icon could not be written: " + icon.error);
    });

    const sizeKB = dirSizeKB(stage);
    const payload = path.join(work, "payload.tar.gz");
    step("Packing " + Math.round(sizeKB / 1024) + " MB into one archive", () => run(tarCmd, ["-czf", payload, "-C", stage, "."]));

    const out = path.join(root, "dist", SETUP_NAME);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true });
    step("Writing " + SETUP_NAME, () => execFileSync(makensis, ["/V2", "/DVERSION=" + version, "/DVIVERSION=" + fileVersion(version), "/DPAYLOAD=" + payload, "/DOUTFILE=" + out, "/DICON=" + path.join(app, "build", "icon.ico"), "/DSIZEKB=" + sizeKB, path.join(__dirname, "installer.nsi")], { stdio: ["ignore", "ignore", "inherit"], timeout: 900000, windowsHide: true }));
    console.log("Built in " + Math.round((Date.now() - started) / 1000) + "s");
    return { path: out, size: fs.statSync(out).size };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    const setup = buildSetup(process.argv[2]);
    console.log("Packed " + setup.path + " (" + setup.size + " bytes)");
  } catch (error) {
    console.error("Setup not built: " + (error.message || error));
    process.exit(1);
  }
}

module.exports = { buildSetup, dirSizeKB, fileVersion, findMakensis, pruneForSetup, SETUP_NAME };
