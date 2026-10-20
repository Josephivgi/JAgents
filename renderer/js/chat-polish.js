// The chat look's extras. chat-ui.css holds the look under html.jsystems-ui
// (set in index.html); this adds what CSS alone cannot: copy buttons on
// messages and code blocks (with the fence language), single-line thread rows
// with their details in a tooltip, and an elapsed timer on the "working" line.

import { toast } from "./util.js";

const COPY_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.8"/><path d="M10.5 5V3.8A1.3 1.3 0 0 0 9.2 2.5H3.8a1.3 1.3 0 0 0-1.3 1.3v5.4a1.3 1.3 0 0 0 1.3 1.3H5"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>';

function copyButton(getText, label, toast) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "jui-copy";
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = COPY_ICON;
  b.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(getText());
    } catch {
      return toast("Could not copy to the clipboard.");
    }
    b.innerHTML = CHECK_ICON;
    b.classList.add("done");
    setTimeout(() => {
      b.innerHTML = COPY_ICON;
      b.classList.remove("done");
    }, 1200);
  });
  return b;
}

// The message as it reads, without the code block header labels.
function bubbleText(bubble) {
  const heads = Array.from(bubble.querySelectorAll(".jui-code-head"));
  for (const h of heads) h.hidden = true;
  const text = bubble.innerText;
  for (const h of heads) h.hidden = false;
  return text;
}

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
}

export function initChatPolish() {
  // When each chat view's current turn started, so the timer survives repaints.
  const started = new WeakMap();

  function decorate() {
    // Rows added here grow the transcript after the app pinned it to the
    // bottom, so re-pin the ones that were at the bottom.
    const pinned = Array.from(document.querySelectorAll(".chatview .transcript")).filter((t) => t.scrollHeight - t.scrollTop - t.clientHeight < 80);
    for (const pre of document.querySelectorAll(".chatview .msg.agent .bubble pre:not([data-jui])")) {
      pre.dataset.jui = "1";
      const wrap = document.createElement("div");
      wrap.className = "jui-code";
      const head = document.createElement("div");
      head.className = "jui-code-head";
      const label = document.createElement("span");
      label.textContent = pre.dataset.lang || "Code";
      head.append(label, copyButton(() => pre.textContent, "Copy code", toast));
      pre.replaceWith(wrap);
      wrap.append(head, pre);
    }
    for (const msg of document.querySelectorAll(".chatview .msg:not([data-jui])")) {
      msg.dataset.jui = "1";
      const bubble = msg.querySelector(".bubble");
      if (!bubble) continue;
      const bar = document.createElement("div");
      bar.className = "jui-msg-actions";
      bar.appendChild(copyButton(() => bubbleText(bubble), "Copy message", toast));
      msg.appendChild(bar);
    }
    for (const item of document.querySelectorAll(".thread-item:not([data-jui])")) {
      item.dataset.jui = "1";
      const t = item.querySelector(".t");
      const s = item.querySelector(".s");
      item.title = [t && t.textContent, s && s.textContent].filter(Boolean).join("\n");
    }
    tick();
    for (const t of pinned) t.scrollTop = t.scrollHeight;
  }

  function tick() {
    for (const view of document.querySelectorAll(".chatview")) {
      const w = view.querySelector(".transcript-inner > .working");
      if (!w) {
        started.delete(view);
        continue;
      }
      if (!started.has(view)) started.set(view, Date.now());
      let el = w.querySelector(".jui-elapsed");
      if (!el) {
        el = document.createElement("span");
        el.className = "jui-elapsed";
        w.appendChild(el);
      }
      const text = fmt(Date.now() - started.get(view));
      if (el.textContent !== text) el.textContent = text;
    }
  }

  // Batch mutations into one pass per frame; decorating adds nodes too, and
  // the data-jui markers stop that from looping.
  let queued = false;
  const obs = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      decorate();
    });
  });
  obs.observe(document.body, { childList: true, subtree: true });
  setInterval(tick, 1000);
  decorate();
}
