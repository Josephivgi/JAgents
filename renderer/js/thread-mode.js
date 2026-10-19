// Thread mode: every ACP chat thread in a list, one open at full width with
// the Plugin App composer. A thread can be split into Code mode next to the
// terminals, handed off, or deleted. Subagent threads show who spawned them.

import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, on, refreshChats, agentName } from "./store.js";
import { ChatView, statusLabel } from "./chat-view.js";
import { openHandoff } from "./dialogs.js";

let side = null;
let main = null;
let view = null;
let current = "";
let filter = "";
const live = new Map(); // chatId -> status from acp-state

export function noteThreadState(snap) {
  live.set(snap.chatId, snap.status);
  if (side) paintList();
  if (snap.chatId === current) paintHead(snap);
}

function timeAgo(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "now";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m";
  if (ms < 86400000) return Math.floor(ms / 3600000) + "h";
  return Math.floor(ms / 86400000) + "d";
}

function paintList() {
  const box = side.querySelector("[data-threads]");
  const needle = filter.trim().toLowerCase();
  const list = store.chats.filter((c) => !needle || (c.title + " " + c.handle + " " + c.harnessId).toLowerCase().includes(needle));
  const byId = new Map(store.chats.map((c) => [c.id, c]));
  box.innerHTML = list.length
    ? list
        .map((c) => {
          const st = live.get(c.id) || "idle";
          const parent = c.parentId ? byId.get(c.parentId) || store.hubAgents.find((a) => a.id === c.parentId) : null;
          return (
            '<button class="thread-item' + (c.id === current ? " active" : "") + '" data-thread="' + esc(c.id) + '">' +
            '<span class="thread-ic">' + harnessIcon(c.harnessId, 16) + '<span class="status-dot ' + (st === "busy" || st === "starting" ? "busy" : st === "error" ? "error" : st === "ready" ? "ok" : "") + '"></span></span>' +
            '<span class="grow"><span class="t">' + esc(c.title) + '</span><span class="s">' + esc(c.handle || agentName(c.harnessId)) + (parent ? " · sub of " + esc(parent.handle || "") : "") + "</span></span>" +
            '<span class="when">' + timeAgo(c.updatedAt) + "</span></button>"
          );
        })
        .join("")
    : '<p class="nav-empty">' + (needle ? "No threads match." : "No threads yet. Start one with New thread.") + "</p>";
}

function paintHead(snap) {
  const head = main.querySelector("[data-thread-head]");
  if (!snap) {
    head.innerHTML = "<h2>New thread</h2>";
    return;
  }
  const st = statusLabel(snap);
  head.innerHTML =
    harnessIcon(snap.harnessId, 18) +
    '<div class="th-text"><h2>' + esc(snap.title) + '</h2><span class="muted small">' + esc(snap.handle || "") + " · " + esc(snap.agentName || agentName(snap.harnessId)) + " · " + esc(snap.cwd || "") + "</span></div>" +
    '<span class="status-dot ' + st.tone + '"></span><span class="pane-status">' + esc(st.text) + "</span>" +
    '<span class="spacer"></span>' +
    '<button class="btn sm secondary" data-th="split" title="Open this thread in Code mode next to your terminals">' + icon("columns", 15) + "Split into Code</button>" +
    '<button class="btn sm secondary" data-th="handoff">' + icon("handoff", 15) + "Hand off</button>" +
    '<button class="icon-btn danger" data-th="delete" title="Delete thread">' + icon("trash", 15) + "</button>";
}

export function openThread(chatId) {
  current = chatId || "";
  window.relay.setSetting("thread.current", current);
  if (view) view.destroy();
  const body = main.querySelector("[data-thread-body]");
  body.className = "thread-body";
  view = new ChatView(body, {
    chatId: current,
    placeholder: current ? "Reply…" : "Start a thread. Pick the agent below.",
    introText: current ? "" : "Pick an agent below (Claude Code runs natively; Devin and Cursor over ACP) and send your first message. Threads keep their transcript, and switching the agent hands the thread over with its context.",
    onCreated: (id) => {
      current = id;
      window.relay.setSetting("thread.current", id);
      refreshChats();
    },
    onChange: (snap) => paintHead(snap),
  });
  paintHead(null);
  paintList();
  setTimeout(() => view && view.focus(), 50);
}

export function renderThreadMode(sideEl, mainEl, actions) {
  side = sideEl;
  main = mainEl;
  side.innerHTML =
    '<div class="side-head"><button class="btn primary block" data-new-thread>' + icon("plus", 16) + "New thread</button></div>" +
    '<div class="side-search">' + icon("search", 14) + '<input type="text" placeholder="Search threads" data-thread-search aria-label="Search threads"></div>' +
    '<div class="thread-list" data-threads></div>';
  main.innerHTML = '<header class="thread-head" data-thread-head></header><div data-thread-body></div>';
  side.addEventListener("click", (e) => {
    if (e.target.closest("[data-new-thread]")) return openThread("");
    const item = e.target.closest("[data-thread]");
    if (item) openThread(item.dataset.thread);
  });
  side.querySelector("[data-thread-search]").addEventListener("input", (e) => {
    filter = e.target.value;
    paintList();
  });
  main.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-th]");
    if (!btn || !view || !view.snap) return;
    const snap = view.snap;
    if (btn.dataset.th === "split") return actions.splitThread(snap.chatId);
    if (btn.dataset.th === "handoff") return openHandoff({ id: snap.chatId, handle: snap.handle, kind: "chat", provider: snap.harnessId, name: snap.agentName });
    if (btn.dataset.th === "delete") {
      try {
        if (await window.relay.chats.remove(snap.chatId)) {
          await refreshChats();
          openThread("");
        }
      } catch (error) {
        toast(errorText(error));
      }
    }
  });
  on("chats", () => paintList());
  on("hub-agents", () => paintList());
  const want = store.info.threadCurrent && store.chats.some((c) => c.id === store.info.threadCurrent) ? store.info.threadCurrent : store.chats[0] ? store.chats[0].id : "";
  openThread(want);
}
