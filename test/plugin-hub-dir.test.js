"use strict";

// Plugins get the hub folder of the JAgents they run in (ctx.hubDir). Inside
// JWorkspace that is not always ~/.jagents (its test runs keep it in a scratch
// folder), and the subagents plugin points its agents' MCP servers at it.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPluginManager } = require("../electron/plugins.cjs");

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jagents-hubdir-"));
}

function manager(dataRoot, hubDir) {
  const settings = new Map();
  const db = { getSetting: (k, fb) => (settings.has(k) ? settings.get(k) : fb), setSetting: (k, v) => settings.set(k, v) };
  return createPluginManager({ dataRoot, hubDir, db, emit: () => {}, notify: () => {}, log: () => {}, bundledDir: "", builtinDir: scratch(), getWindow: () => null });
}

function probe(dataRoot) {
  const dir = path.join(dataRoot, "plugins", "hub-probe");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ id: "hub-probe", name: "Hub probe" }));
  fs.writeFileSync(path.join(dir, "main.cjs"), 'exports.activate = (ctx) => { ctx.handle("hub-dir", () => ctx.hubDir); };\n');
}

test("plugins get the hub folder the app was given", () => {
  const dataRoot = scratch();
  const hubDir = scratch();
  probe(dataRoot);
  const plugins = manager(dataRoot, hubDir);
  plugins.start({ hubCall: async () => null });
  try {
    assert.strictEqual(plugins.invoke("hub-probe", "hub-dir"), hubDir);
  } finally {
    plugins.stop();
  }
});

test("without one they keep the old lookup (JAGENTS_HOME, else ~/.jagents)", () => {
  const dataRoot = scratch();
  probe(dataRoot);
  const plugins = manager(dataRoot, undefined);
  plugins.start({ hubCall: async () => null });
  try {
    const expected = process.env.JAGENTS_HOME ? path.resolve(process.env.JAGENTS_HOME) : path.join(os.homedir(), ".jagents");
    assert.strictEqual(plugins.invoke("hub-probe", "hub-dir"), expected);
  } finally {
    plugins.stop();
  }
});
