#!/usr/bin/env node
"use strict";

// Publishes a GitHub release with the app package the in-app updater
// downloads (JAgents-<tag>.tar.gz, the tagged source without node_modules).
//   node scripts/release.cjs notes.md          (tag v<package.json version>)
// The tag must already be pushed. A release that exists gets the package
// uploaded (replacing an old one) and its notes updated.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const notes = process.argv[2];
if (!notes || !fs.existsSync(notes)) {
  console.error("usage: node scripts/release.cjs <notes.md>");
  process.exit(1);
}
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const tag = "v" + version;
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

run("git", ["rev-parse", "--verify", "refs/tags/" + tag]);
if (!run("git", ["ls-remote", "--tags", "origin", tag])) throw new Error(tag + " is not pushed to origin.");
fs.mkdirSync(path.join(root, "dist"), { recursive: true });
const asset = path.join("dist", "JAgents-" + tag + ".tar.gz");
run("git", ["archive", "--format=tar.gz", "--prefix=JAgents/", "-o", asset, tag]);

let exists = true;
try {
  run("gh", ["release", "view", tag]);
} catch {
  exists = false;
}
if (exists) {
  run("gh", ["release", "upload", tag, asset, "--clobber"]);
  run("gh", ["release", "edit", tag, "--notes-file", notes, "--draft=false", "--latest"]);
} else {
  run("gh", ["release", "create", tag, asset, "--title", "JAgents " + version, "--notes-file", notes, "--latest"]);
}
console.log(run("gh", ["release", "view", tag, "--json", "url", "-q", ".url"]));
