#!/usr/bin/env node
"use strict";

// Drives the running JAgents window over the Chrome DevTools Protocol for
// verification: evaluate JS in the page or save a screenshot of the window.
//   node scripts/cdp.cjs eval "<js>"        (port from JAGENTS_CDP_PORT, default 9333)
//   node scripts/cdp.cjs shot out.png
// Start JAgents with: npx electron . --remote-debugging-port=9333

const fs = require("node:fs");

const port = Number(process.env.JAGENTS_CDP_PORT || 9333);

async function target() {
  const res = await fetch("http://127.0.0.1:" + port + "/json/list");
  const list = await res.json();
  const page = list.find((t) => t.type === "page" && t.url.startsWith("app://shell"));
  if (!page) throw new Error("JAgents window not found on port " + port);
  return page.webSocketDebuggerUrl;
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const ws = new WebSocket(await target());
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  if (cmd === "eval") {
    const out = await send("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
    if (out.result.exceptionDetails) console.error(JSON.stringify(out.result.exceptionDetails, null, 2));
    else console.log(typeof out.result.result.value === "string" ? out.result.result.value : JSON.stringify(out.result.result.value, null, 2));
  } else if (cmd === "type") {
    // Real keyboard input into whatever has focus.
    await send("Input.insertText", { text: arg });
    console.log("typed");
  } else if (cmd === "key") {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: arg, code: arg, windowsVirtualKeyCode: arg === "Enter" ? 13 : arg === "ArrowDown" ? 40 : 0, text: arg === "Enter" ? String.fromCharCode(13) : undefined });
    console.log("key " + arg);
  } else if (cmd === "shot") {
    const out = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(arg || "shot.png", Buffer.from(out.result.data, "base64"));
    console.log("saved " + (arg || "shot.png"));
  }
  ws.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
