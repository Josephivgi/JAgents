// Thread mode: every ACP chat thread in a list, one open at full width with
// the Plugin App composer. A thread can be split into Code mode next to the
// terminals or deleted. Picking another agent in the composer hands the thread
// over with its context automatically. Subagent threads show who spawned them.

import { esc, toast, errorText } from "./util.js";
import { icon, harnessIcon } from "./icons.js";
import { store, on, refreshChats, agentName } from "./store.js";
import { ChatView } from "./chat-view.js";

let side = null;
let main = null;
let view = null;
let current = "";
let filter = "";

// Settled threads (chatId -> settled at, ms) sit in a foldable Settled group
// at the bottom of the list. Working threads show larger with a spinner. A
// settled thread that starts working again moves back up by itself.
const WORKING = new Set(["busy", "starting"]);
const UNDO_MS = 8000;
let settled = {};
let folded = false;
let undo = null; // {ids, timer} after Settle all
const status = new Map(); // chatId -> last known status
let recheck = 0;

const isWorking = (id) => WORKING.has(status.get(id));
const titleOf = (id) => {
  const c = store.chats.find((x) => x.id === id);
  return c ? c.title : "Thread";
};
const plural = (n) => n + " thread" + (n === 1 ? "" : "s");

function saveSettled() {
  window.jagents.setSetting("thread.settled", settled);
}

// Only a change in working/not working repaints the list, so the stream of
// state events while an agent runs does not rebuild it.
function setStatus(id, next) {
  const prev = status.get(id);
  if (prev === next) return false;
  status.set(id, next);
  if (settled[id] && WORKING.has(next) && prev && !WORKING.has(prev) && Date.now() - settled[id] > 1500) {
    delete settled[id];
    saveSettled();
    toast("“" + titleOf(id) + "” is working again, moved back up");
    return true;
  }
  return WORKING.has(prev) !== WORKING.has(next);
}

// A working spinner never sticks: while a thread shows as working, the main
// process is asked again every few seconds.
function watchWorking() {
  const any = Array.from(status.values()).some((s) => WORKING.has(s));
  if (any && !recheck) {
    recheck = setInterval(async () => {
      try {
        let changed = false;
        for (const a of await window.jagents.hub.agents()) if (a && a.kind === "chat" && a.id && a.status) changed = setStatus(a.id, a.status) || changed;
        if (changed) paintList();
        else watchWorking();
      } catch {
        /* the next event corrects it */
      }
    }, 5000);
  } else if (!any && recheck) {
    clearInterval(recheck);
    recheck = 0;
  }
}

export function noteThreadState(snap) {
  if (!side) return;
  if (snap.chatId && snap.status && setStatus(snap.chatId, snap.status)) paintList();
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
  const list = visibleChats();
  const byId = new Map(store.chats.map((c) => [c.id, c]));
  const open = list.filter((c) => !settled[c.id]);
  const done = list.filter((c) => settled[c.id]).sort((a, b) => settled[b.id] - settled[a.id]);
  const row = (c) => {
    const parent = c.parentId ? byId.get(c.parentId) || store.hubAgents.find((a) => a.id === c.parentId) : null;
    const cls = (c.id === current ? " active" : "") + (settled[c.id] ? " settled" : "") + (isWorking(c.id) ? " is-working" : "");
    return (
      '<button class="thread-item' + cls + '" data-thread="' + esc(c.id) + '">' +
      '<span class="thread-ic">' + harnessIcon(c.harnessId, 16) + "</span>" +
      '<span class="grow"><span class="t">' + esc(c.title) + '</span><span class="s">' + esc(c.handle || agentName(c.harnessId)) + (parent ? " · sub of " + esc(parent.handle || "") : "") + "</span></span>" +
      (settled[c.id] ? '<span class="settle-mark" aria-hidden="true">' + icon("check", 14) + "</span>" : "") +
      (isWorking(c.id) ? '<span class="spinner sm" role="img" aria-label="Working"></span>' : "") +
      '<span class="when">' + timeAgo(c.updatedAt) + "</span></button>"
    );
  };
  box.innerHTML = list.length
    ? open.map(row).join("") +
      (done.length
        ? '<button type="button" class="settle-group nav-label" data-settle-group aria-expanded="' + !folded + '" title="' + (folded ? "Show" : "Hide") + ' settled threads">' +
          '<span class="settle-chev' + (folded ? " folded" : "") + '">' + icon("chevronDown", 12) + "</span>Settled · " + done.length + "</button>" +
          (folded ? "" : done.map(row).join(""))
        : "")
    : '<p class="nav-empty">' + (filter.trim() ? "No threads match." : "No threads yet. Start one with New thread.") + "</p>";
  paintSettleAll(list);
  watchWorking();
}

// Settle all settles every thread in the list (a search narrows it) that is
// not working right now. For a few seconds it turns into Undo.
const settleable = (list) => list.filter((c) => !settled[c.id] && !isWorking(c.id));

function paintSettleAll(list) {
  const btn = side.querySelector("[data-settle-all]");
  const n = undo ? 0 : settleable(list).length;
  btn.innerHTML = undo ? icon("undo", 15) + "Undo settle all" : icon("check", 15) + "Settle all" + (n ? ' <span class="settle-n">' + n + "</span>" : "");
  btn.title = undo ? "Move the threads Settle all just settled back up" : n ? "Settle every thread in the list that is not working right now" : "Nothing to settle";
  btn.disabled = !undo && !n;
}

function visibleChats() {
  const needle = filter.trim().toLowerCase();
  return store.chats.filter((c) => !needle || (c.title + " " + c.handle + " " + c.harnessId).toLowerCase().includes(needle));
}

function settleAll() {
  if (undo) {
    clearTimeout(undo.timer);
    for (const id of undo.ids) delete settled[id];
    toast("Moved " + plural(undo.ids.length) + " back up");
    undo = null;
  } else {
    const list = visibleChats();
    const ids = settleable(list).map((c) => c.id);
    if (!ids.length) return;
    const now = Date.now();
    ids.forEach((id, i) => (settled[id] = now - i)); // keep their list order inside Settled
    const working = list.filter((c) => !settled[c.id] && isWorking(c.id)).length;
    undo = {
      ids,
      timer: setTimeout(() => {
        undo = null;
        paintList();
      }, UNDO_MS),
    };
    toast("Settled " + plural(ids.length) + (working ? " · " + working + " still working, left on top" : ""));
  }
  saveSettled();
  paintList();
}

function setSettled(id, on) {
  if (!id) return;
  if (on) settled[id] = Date.now();
  else delete settled[id];
  saveSettled();
  paintList();
  if (view && view.snap) paintHead(view.snap);
  toast(on ? "Settled “" + titleOf(id) + "”" : "Moved “" + titleOf(id) + "” back up");
}

function paintHead(snap) {
  const head = main.querySelector("[data-thread-head]");
  if (!snap) {
    head.innerHTML = "<h2>New thread</h2>";
    return;
  }
  head.innerHTML =
    harnessIcon(snap.harnessId, 18) +
    '<div class="th-text"><h2>' + esc(snap.title) + '</h2><span class="muted small">' + esc(snap.handle || "") + " · " + esc(snap.agentName || agentName(snap.harnessId)) + " · " + esc(snap.cwd || "") + "</span></div>" +
    '<span class="spacer"></span>' +
    (settled[snap.chatId]
      ? '<button class="btn sm ghost settle-btn" data-th="settle" aria-pressed="true" title="Move this thread back up with the active ones">' + icon("undo", 15) + "Unsettle</button>"
      : '<button class="btn sm secondary settle-btn" data-th="settle" aria-pressed="false" title="Mark this thread done and move it to the bottom of the list">' + icon("check", 15) + "Settle</button>") +
    '<button class="btn sm secondary" data-th="split" title="Open this thread in Code mode next to your terminals">' + icon("columns", 15) + "Split into Code</button>" +
    '<button class="icon-btn danger" data-th="delete" title="Delete thread">' + icon("trash", 15) + "</button>";
}

export function openThread(chatId) {
  current = chatId || "";
  window.jagents.setSetting("thread.current", current);
  if (view) view.destroy();
  const body = main.querySelector("[data-thread-body]");
  body.className = "thread-body";
  view = new ChatView(body, {
    chatId: current,
    placeholder: current ? "Reply…" : "Start a thread. Pick the agent below.",
    introText: current ? "" : "Pick an agent below (Claude Code runs natively; Devin and Cursor over ACP) and send your first message. Threads keep their transcript, and switching the agent hands the thread over with its context.",
    onCreated: (id) => {
      current = id;
      view.input.placeholder = "Reply…";
      window.jagents.setSetting("thread.current", id);
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
    '<div class="settle-bar"><button type="button" class="btn sm ghost" data-settle-all></button></div>' +
    '<div class="thread-list" data-threads></div>';
  main.innerHTML = '<header class="thread-head" data-thread-head></header><div data-thread-body></div>';
  settled = Object.assign({}, store.info.threadSettled || {});
  folded = Boolean(store.info.threadSettledFolded);
  for (const a of store.hubAgents || []) if (a && a.kind === "chat" && a.id && a.status) status.set(a.id, a.status);
  side.addEventListener("click", (e) => {
    if (e.target.closest("[data-new-thread]")) return openThread("");
    if (e.target.closest("[data-settle-all]")) return settleAll();
    if (e.target.closest("[data-settle-group]")) {
      folded = !folded;
      window.jagents.setSetting("thread.settledFolded", folded);
      return paintList();
    }
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
    if (btn.dataset.th === "settle") return setSettled(snap.chatId, !settled[snap.chatId]);
    if (btn.dataset.th === "delete") {
      try {
        if (await window.jagents.chats.remove(snap.chatId)) {
          await refreshChats();
          openThread("");
        }
      } catch (error) {
        toast(errorText(error));
      }
    }
  });
  on("chats", () => {
    // Forget settled threads that were deleted.
    if (store.chats.length) {
      const ids = new Set(store.chats.map((c) => c.id));
      const gone = Object.keys(settled).filter((id) => !ids.has(id));
      for (const id of gone) delete settled[id];
      if (gone.length) saveSettled();
    }
    paintList();
  });
  on("hub-agents", (agents) => {
    for (const a of agents || []) if (a && a.kind === "chat" && a.id && a.status) setStatus(a.id, a.status);
    paintList();
  });
  const want = store.info.threadCurrent && store.chats.some((c) => c.id === store.info.threadCurrent) ? store.info.threadCurrent : store.chats[0] ? store.chats[0].id : "";
  openThread(want);
}
