// Update reminders: a card in the bottom right when a new version is out, while
// it installs, and once it needs a restart. "Later" hides it for a few hours
// (the update.snooze setting); then it comes back until the update is done.

import { esc, toast, errorText } from "./util.js";
import { icon } from "./icons.js";
import { store, fire } from "./store.js";

const SNOOZE_MS = 4 * 60 * 60 * 1000;
let el = null;
let last = null;
let timer = 0;

function snoozed(u) {
  const s = store.info && store.info.updateSnooze;
  const key = u.applied ? "restart:" + u.applied : u.latest;
  return Boolean(s && s.key === key && s.until > Date.now());
}

function snooze(u) {
  const key = u.applied ? "restart:" + u.applied : u.latest;
  store.info.updateSnooze = { key, until: Date.now() + SNOOZE_MS };
  window.jagents.setSetting("update.snooze", store.info.updateSnooze).catch(() => {});
}

// The first lines of the release notes, as plain text.
function preview(notes) {
  const lines = String(notes || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(#{1,6}|[-*])\s*/, "").replace(/\*\*|`/g, "").trim())
    .filter((l) => l && !/^(new|improved|fixed)$/i.test(l));
  return lines.slice(0, 2);
}

function hide() {
  if (!el) return;
  el.classList.add("leaving");
  const gone = el;
  el = null;
  setTimeout(() => gone.remove(), 180);
}

function cardHtml(u) {
  if (u.applied)
    return (
      '<div class="upd-head">' + icon("check", 16) + "<b>JAgents " + esc(u.applied) + " is installed</b></div>" +
      '<p class="muted small">Restart to start using it. Running terminals keep going.</p>' +
      '<div class="upd-actions"><button type="button" class="btn sm ghost" data-upd="later">Later</button><button type="button" class="btn sm primary" data-upd="restart">' + icon("restart", 14) + "Restart now</button></div>"
    );
  if (u.applying)
    return (
      '<div class="upd-head"><span class="spinner"></span><b>Installing JAgents ' + esc(u.latest) + "</b></div>" +
      '<p class="muted small">' + esc(u.step || "Downloading") + "…</p>"
    );
  const lines = preview(u.notes);
  return (
    '<div class="upd-head">' + icon("update", 16) + "<b>JAgents " + esc(u.latest) + " is available</b>" +
    '<button type="button" class="icon-btn upd-x" data-upd="later" aria-label="Remind me later" title="Remind me later">' + icon("close", 14) + "</button></div>" +
    '<p class="muted small">You have v' + esc(u.current) + ".</p>" +
    (lines.length ? '<ul class="upd-notes">' + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul>" : "") +
    (u.error ? '<p class="err-row small">' + esc(u.error) + "</p>" : "") +
    '<div class="upd-actions"><button type="button" class="btn sm ghost" data-upd="notes">What\'s new</button><button type="button" class="btn sm ghost" data-upd="later">Later</button><button type="button" class="btn sm primary" data-upd="apply">Install</button></div>'
  );
}

function show(u) {
  if (!el) {
    el = document.createElement("div");
    el.className = "update-pop";
    el.setAttribute("role", "status");
    el.addEventListener("click", onClick);
    document.body.appendChild(el);
  }
  const html = cardHtml(u);
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
}

async function onClick(e) {
  const b = e.target.closest("[data-upd]");
  if (!b || !last) return;
  const act = b.dataset.upd;
  try {
    if (act === "later") {
      snooze(last);
      hide();
    } else if (act === "notes") {
      const { openSettings } = await import("./settings.js");
      openSettings("updates");
    } else if (act === "apply") await window.jagents.updates.apply();
    else if (act === "restart") await window.jagents.updates.restart();
  } catch (error) {
    toast(errorText(error));
  }
}

export function noteUpdate(u) {
  last = u;
  if (!u || !(u.available || u.applied || u.applying)) return hide();
  if (u.applying) return show(u);
  if (snoozed(u)) return hide();
  show(u);
}

// A snoozed reminder comes back when its time is up.
clearInterval(timer);
timer = setInterval(() => last && noteUpdate(last), 10 * 60 * 1000);
fire("update-popup-ready");
