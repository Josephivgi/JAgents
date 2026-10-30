"use strict";

// Permission modes, approval cards and the message queue, through the real
// acp-host and AcpClient against a scripted ACP agent (test/fixtures). These
// cover the host plumbing; real agents are checked in the running app.

const test = require("node:test");
const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { setExtraAgents } = require("../lib/agents");
const { autoPermissionOption } = require("../lib/acp-permissions");
const { createAcpHost } = require("../electron/acp-host.cjs");

const FAKE = path.join(__dirname, "fixtures", "fake-acp-agent.cjs");
setExtraAgents(() => [{ id: "fake", name: "Fake", install: "", resolve: () => ({ command: process.execPath, args: [FAKE], env: {} }) }]);

function memoryDb() {
  const chats = new Map();
  const settings = new Map();
  return {
    getChat: (id) => (chats.has(id) ? JSON.parse(JSON.stringify(chats.get(id))) : null),
    saveChat: (c) => chats.set(c.id, JSON.parse(JSON.stringify(c))),
    createChat: (c) => chats.set(c.id, Object.assign({ acpSessionId: "" }, c)),
    listChats: () => Array.from(chats.values()),
    deleteChat: (id) => chats.delete(id),
    getSetting: (k, d) => (settings.has(k) ? settings.get(k) : d),
    setSetting: (k, v) => settings.set(k, v),
  };
}

function makeHost() {
  const events = [];
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "jagents-perm-"));
  const host = createAcpHost({
    dataRoot,
    db: memoryDb(),
    emit: (type, payload) => events.push({ type, payload }),
    defaultCwd: () => dataRoot,
    mcpEntryFor: () => [],
    contextFor: () => "",
  });
  return { host, events };
}

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
};

const reply = (host, id) => host.lastReply(id);

test("modes decide which requests JAgents answers", () => {
  const p = (kind) => ({ toolCall: { kind }, options: [{ optionId: "a", kind: "allow_once" }, { optionId: "b", kind: "allow_always" }, { optionId: "r", kind: "reject_once" }] });
  assert.equal(autoPermissionOption("ask", p("read")), "");
  assert.equal(autoPermissionOption("edits", p("edit")), "a");
  assert.equal(autoPermissionOption("edits", p("execute")), "");
  assert.equal(autoPermissionOption("auto", p("execute")), "a");
  assert.equal(autoPermissionOption("full", p("execute")), "b");
});

test("Ask shows the agent's options and sends the one picked", async () => {
  const { host, events } = makeHost();
  const chat = host.createChat({ harnessId: "fake" });
  const done = host.prompt(chat.chatId, "execute");
  const snap = await until(() => {
    const s = host.snapshot(chat.chatId);
    return s.permissions.length ? s : null;
  });
  assert.equal(snap.permissionMode, "ask");
  assert.deepEqual(snap.permissions[0].options.map((o) => o.optionId), ["yes", "yes-always", "no"]);
  assert.ok(events.some((e) => e.type === "acp-attention" && e.payload.kind === "permission"));
  host.answerPermission(chat.chatId, snap.permissions[0].id, "no");
  await done;
  assert.equal(reply(host, chat.chatId), "outcome:no");
  const tool = host.snapshot(chat.chatId).transcript.find((r) => r.role === "tool");
  assert.equal(tool.status, "failed");
  host.stopAll();
});

test("Accept edits allows edits by itself and asks for commands", async () => {
  const { host } = makeHost();
  const chat = host.createChat({ harnessId: "fake" });
  await host.setPermissionMode(chat.chatId, "edits");
  await host.prompt(chat.chatId, "edit");
  assert.equal(reply(host, chat.chatId), "outcome:yes");
  const done = host.prompt(chat.chatId, "execute");
  const snap = await until(() => {
    const s = host.snapshot(chat.chatId);
    return s.permissions.length ? s : null;
  });
  // Switching the mode answers a waiting card when the new mode would.
  await host.setPermissionMode(chat.chatId, "full");
  await done;
  assert.equal(snap.permissions.length, 1);
  assert.equal(reply(host, chat.chatId), "outcome:yes-always");
  host.stopAll();
});

test("Stop answers a waiting card as cancelled", async () => {
  const { host } = makeHost();
  const chat = host.createChat({ harnessId: "fake" });
  const done = host.prompt(chat.chatId, "execute");
  await until(() => host.snapshot(chat.chatId).permissions.length);
  host.cancel(chat.chatId);
  await done;
  assert.equal(host.snapshot(chat.chatId).permissions.length, 0);
  assert.equal(reply(host, chat.chatId), "outcome:cancelled");
  host.stopAll();
});

test("messages sent mid-turn queue, can be edited, and go out in order", async () => {
  const { host } = makeHost();
  const chat = host.createChat({ harnessId: "fake" });
  await host.setPermissionMode(chat.chatId, "auto");
  const first = host.prompt(chat.chatId, "execute 1");
  await until(() => host.snapshot(chat.chatId).status === "busy");
  const queued = await host.prompt(chat.chatId, "read");
  assert.equal(queued.queue.length, 1);
  host.editQueued(chat.chatId, queued.queue[0].id, "edit");
  await first;
  await until(() => host.snapshot(chat.chatId).transcript.filter((r) => r.role === "user").length === 2 && !host.isBusy(chat.chatId));
  const users = host.snapshot(chat.chatId).transcript.filter((r) => r.role === "user").map((r) => r.text);
  assert.deepEqual(users, ["execute 1", "edit"]);
  // Every row has an id the chat patches by.
  assert.ok(host.snapshot(chat.chatId).transcript.every((r) => r.id));
  host.stopAll();
});

test("stopping drops queued messages instead of starting the agent again", async () => {
  const { host } = makeHost();
  const chat = host.createChat({ harnessId: "fake" });
  await host.setPermissionMode(chat.chatId, "auto");
  const first = host.prompt(chat.chatId, "execute 5");
  await until(() => host.snapshot(chat.chatId).status === "busy");
  await host.prompt(chat.chatId, "read");
  assert.equal(host.snapshot(chat.chatId).queued, 1);
  host.stopAll();
  await first.catch(() => {});
  // The ended turn's queue drain would run on the next tick.
  await new Promise((r) => setTimeout(r, 500));
  assert.deepEqual(host.liveIds(), []);
  assert.equal(host.isBusy(chat.chatId), false);
  assert.deepEqual(host.snapshot(chat.chatId).transcript.filter((r) => r.role === "user").map((r) => r.text), ["execute 5"]);
  await assert.rejects(host.prompt(chat.chatId, "read"), /stopping/);
});

test("a subagent asks through its parent's thread, named on the card", async () => {
  const { host } = makeHost();
  const parent = host.createChat({ harnessId: "fake", handle: "fake-1" });
  const params = { toolCall: { toolCallId: "x", title: "Run rm notes.txt", kind: "execute" }, options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }] };
  const asked = host.askForSubagent({ parent: "fake-1", handle: "fake-1/devin-1", agentName: "Devin", harnessId: "devin", params });
  const card = host.snapshot(parent.chatId).permissions[0];
  assert.deepEqual(card.from, { handle: "fake-1/devin-1", agentName: "Devin", harnessId: "devin" });
  // The parent's own turn ending leaves the subagent's request waiting.
  await host.setPermissionMode(parent.chatId, "edits");
  await host.prompt(parent.chatId, "edit");
  assert.equal(host.snapshot(parent.chatId).permissions.filter((p) => p.from).length, 1);
  host.answerPermission(parent.chatId, card.id, "ok");
  assert.deepEqual(await asked, { outcome: { outcome: "selected", optionId: "ok" } });
  // The parent's mode applies to its subagents.
  await host.setPermissionMode(parent.chatId, "auto");
  assert.equal((await host.askForSubagent({ parent: "fake-1", handle: "fake-1/devin-1", params })).outcome.optionId, "ok");
  // Stopping the subagent drops its card.
  await host.setPermissionMode(parent.chatId, "ask");
  const dropped = host.askForSubagent({ parent: "fake-1", handle: "fake-1/devin-1", params });
  host.cancelSubagentPermissions("fake-1/devin-1");
  assert.equal((await dropped).outcome.outcome, "cancelled");
  host.stopAll();
});
