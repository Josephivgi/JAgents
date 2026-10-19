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

function buildSetup(tagArg) {
  const tag = tagArg || "v" + JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  const makensis = findMakensis(process.env);
  if (!makensis) throw new Error("makensis (NSIS) not found.");
  const runtime = path.join(root, "node_modules", "electron", "dist");
  if (!fs.existsSync(path.join(runtime, "electron.exe"))) throw new Error("No Windows Electron runtime in node_modules/electron/dist. Run npm install on Windows.");
  const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd: cwd || root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
  run("git", ["rev-parse", "--verify", "refs/tags/" + tag]);
  const version = JSON.parse(run("git", ["show", tag + ":package.json"])).version;

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-setup-"));
  try {
    const stage = path.join(work, "JAgents");
    fs.cpSync(runtime, stage, { recursive: true });
    fs.renameSync(path.join(stage, "electron.exe"), path.join(stage, "JAgents.exe"));
    fs.rmSync(path.join(stage, "resources", "default_app.asar"), { force: true });

    // The tagged source, unpacked with Windows' own tar (see lib/updater.js).
    const app = path.join(stage, "resources", "app");
    run("git", ["archive", "--format=tar", "--prefix=app/", "-o", path.join(work, "app.tar"), tag]);
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    run(fs.existsSync(tar) ? tar : "tar", ["-xf", "../../app.tar"], path.join(stage, "resources"));
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    const npm = fs.existsSync(npmCli) ? [process.execPath, [npmCli]] : ["npm", []];
    run(npm[0], npm[1].concat(["ci", "--omit=dev", "--no-audit", "--no-fund"]), app);

    const icon = applyIcon(path.join(stage, "JAgents.exe"), path.join(app, "build", "icon.ico"));
    if (!icon.ok) throw new Error("The app icon could not be written: " + icon.error);

    const out = path.join(root, "dist", SETUP_NAME);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.rmSync(out, { force: true });
    execFileSync(makensis, ["/V2", "/DVERSION=" + version, "/DVIVERSION=" + fileVersion(version), "/DSTAGE=" + stage, "/DOUTFILE=" + out, "/DICON=" + path.join(app, "build", "icon.ico"), path.join(__dirname, "installer.nsi")], { stdio: "inherit", timeout: 900000, windowsHide: true });
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

module.exports = { buildSetup, fileVersion, findMakensis, SETUP_NAME };
