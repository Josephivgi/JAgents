// Usage in the sidebar dock: the two plan limits running out fastest across
// Claude, Codex, Cursor, Droid and OpenCode Go, one line each. "Fastest" is
// the share used so far compared with how much of the window has passed, so
// 30% used one hour into a 5 hour window ranks above 60% used with a day left
// of a week. Clicking opens every provider and limit with reset times. The
// numbers come from electron/usage.cjs.

import { esc, toast, errorText } from "./util.js";
import { icon } from "./icons.js";
import { modal } from "./dialogs.js";

const SHOWN = 2;

let box = null;
let data = null;
let busy = false;

const clamp = (p) => Math.max(0, Math.min(100, Math.round(p)));

function left(ms) {
  if (!ms) return "";
  const m = Math.round((ms - Date.now()) / 60000);
  if (m <= 0) return "now";
  if (m < 60) return m + "m";
  if (m < 1440) return Math.floor(m / 60) + "h" + (m % 60 ? " " + (m % 60) + "m" : "");
  return Math.round(m / 1440) + "d";
}

function resets(ms) {
  if (!ms) return "";
  const m = Math.round((ms - Date.now()) / 60000);
  if (m < 1440) return "resets in " + left(ms);
  return "resets " + new Date(ms).toLocaleString(undefined, { weekday: "short", month: m > 6 * 1440 ? "short" : undefined, day: m > 6 * 1440 ? "numeric" : undefined, hour: "numeric", minute: "2-digit" });
}

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  return Math.floor(s / 3600) + " h ago";
}

// Where this limit lands at reset if use keeps its current pace.
function pace(l) {
  if (l.blocked || l.percent >= 100) return 999;
  if (!l.windowMs || !l.resetsAt) return l.percent;
  const passed = 1 - (l.resetsAt - Date.now()) / l.windowMs;
  if (passed < 0.1) return l.percent; // too early in the window to project
  return l.percent / Math.min(1, passed);
}

function tone(l) {
  const p = Math.max(l.percent, Math.min(pace(l), 999) * 0.9);
  return l.blocked || l.percent >= 90 || p >= 110 ? "danger" : l.percent >= 75 || p >= 90 ? "warn" : "ok";
}

function ranked() {
  const all = [];
  for (const p of data || []) if (p.status === "ok") for (const l of p.limits) all.push(Object.assign({ provider: p.name, pace: pace(l) }, l));
  return all.sort((a, b) => b.pace - a.pace || b.percent - a.percent);
}

function row(l) {
  const v = clamp(l.percent);
  const proj = l.pace >= 999 ? "used up" : l.pace > l.percent + 1 ? "on pace for " + Math.round(l.pace) + "%" : "";
  const tip = l.provider + " " + l.label + ": " + v + "% used" + (proj ? ", " + proj : "") + (l.resetsAt ? ", " + resets(l.resetsAt) : "");
  return (
    '<span class="usage-row" title="' + esc(tip) + '">' +
    '<span class="usage-lbl"><b>' + esc(l.provider) + "</b> " + esc(l.label) + "</span>" +
    '<span class="usage-bar"><i class="' + tone(l) + '" style="width:' + v + '%"></i></span>' +
    '<span class="usage-pct">' + v + "%</span></span>"
  );
}

function paint() {
  if (!box) return;
  const sum = box.querySelector("[data-usage-summary]");
  const rows = box.querySelector("[data-usage-rows]");
  box.querySelector("[data-usage-refresh]").disabled = busy;
  box.classList.toggle("busy", busy);
  if (!data) {
    sum.textContent = "Checking";
    rows.innerHTML = "";
    return;
  }
  const top = ranked();
  const issues = data.filter((p) => p.status !== "ok");
  const signin = issues.filter((p) => p.status === "signin");
  rows.innerHTML = top.slice(0, SHOWN).map(row).join("");
  let s = !data.length ? "No agents found" : top.length ? "" : "No limits reported";
  if (signin.length === 1) s = signin[0].name + " needs sign-in";
  else if (signin.length) s = signin.length + " need sign-in";
  else if (issues.length) s = issues.length === 1 ? issues[0].name + " unavailable" : issues.length + " unavailable";
  sum.textContent = s;
  sum.hidden = !s;
  sum.classList.toggle("warn-text", Boolean(issues.length));
  sum.title = issues.map((p) => p.name + ": " + (p.message || "unavailable")).join("\n");
}

function details() {
  const body = (data || [])
    .map((p) => {
      const when = p.checkedAt ? '<span class="muted small">Checked ' + ago(p.checkedAt) + "</span>" : "";
      let inner;
      if (p.status !== "ok") inner = '<p class="usage-note' + (p.status === "signin" ? " warn-text" : "") + '">' + esc(p.message || "Unavailable") + "</p>";
      else if (!p.limits.length) inner = '<p class="usage-note">No plan limits reported.</p>';
      else
        inner = p.limits
          .map((l) => {
            const v = clamp(l.percent);
            const lp = pace(l);
            const proj = lp >= 999 ? "Used up" : lp > l.percent + 1 ? "On pace for " + Math.round(lp) + "%" : "";
            const note = [proj, resets(l.resetsAt)].filter(Boolean).join(" · ");
            return (
              '<div class="usage-detail"><div class="usage-detail-top"><span>' + esc(l.label) + '</span><span class="usage-num">' + v + "% used</span></div>" +
              '<span class="usage-bar big"><i class="' + tone(l) + '" style="width:' + v + '%"></i></span>' +
              (note ? '<span class="muted small">' + esc(note) + "</span>" : "") + "</div>"
            );
          })
          .join("");
      return '<section class="usage-section"><div class="usage-section-head"><h3>' + esc(p.name) + "</h3>" + (p.plan ? '<span class="chip">' + esc(p.plan) + "</span>" : "") + '<span class="spacer"></span>' + when + "</div>" + inner + "</section>";
    })
    .join("");
  modal(
    '<div class="modal-head">' + icon("usage", 18) + '<h2>Usage</h2><button type="button" class="icon-btn" data-close aria-label="Close">' + icon("close", 16) + "</button></div>" +
      '<div class="modal-body">' + (body || '<p class="muted">No Claude, Codex, Cursor, Droid or OpenCode Go sign-in found on this computer.</p>') +
      '<p class="muted small">Read from each agent\'s own sign-in on this computer. The sidebar shows the ' + SHOWN + " limits running out fastest: share used compared with how much of the window has passed.</p></div>",
    { wide: true },
  );
}

async function refresh() {
  if (busy) return;
  busy = true;
  paint();
  try {
    data = await window.jagents.usage.refresh();
  } catch (error) {
    toast("Usage: " + errorText(error));
  }
  busy = false;
  paint();
}

export function initUsage(el) {
  box = el;
  box.addEventListener("click", (e) => {
    if (e.target.closest("[data-usage-refresh]")) return refresh();
    if (e.target.closest("[data-usage-open]")) return details();
  });
  window.jagents.usage
    .get()
    .then((v) => {
      if (v && v.length) data = v;
      paint();
    })
    .catch(() => {});
  setInterval(paint, 60000);
  paint();
}

export function noteUsage(v) {
  data = v;
  paint();
}
