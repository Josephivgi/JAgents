"use strict";
// Renders build/icon.svg to build/icon.png (512) and build/icon.ico (16-256),
// and copies it to renderer/icon.svg for the top bar.
// Run with Electron: electron scripts/make-icon.cjs
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const BUILD = path.join(__dirname, "..", "build");
const SVG = fs.readFileSync(path.join(BUILD, "icon.svg"), "utf8");
// Sizes up to 32 use a heavier drawing (icon-small.svg) so BETA stays readable.
const SMALL = fs.existsSync(path.join(BUILD, "icon-small.svg")) ? fs.readFileSync(path.join(BUILD, "icon-small.svg"), "utf8") : SVG;
const SIZES = [16, 24, 32, 48, 64, 128, 256];

async function render(win, size) {
  const svg = size <= 32 ? SMALL : SVG;
  const html = "<html><body style='margin:0;background:transparent'><img width='" + size + "' height='" + size + "' src='data:image/svg+xml;base64," + Buffer.from(svg).toString("base64") + "'></body></html>";
  win.setContentSize(size, size);
  await win.loadURL("data:text/html;base64," + Buffer.from(html).toString("base64"));
  await new Promise((r) => setTimeout(r, 150));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  return img.resize({ width: size, height: size, quality: "best" }).toPNG();
}

function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, data }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, o);
    head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt8(0, o + 2);
    head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(data.length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([head].concat(pngs.map((p) => p.data)));
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, frame: false, transparent: true, useContentSize: true, width: 512, height: 512, webPreferences: { offscreen: true } });
  fs.writeFileSync(path.join(BUILD, "icon.png"), await render(win, 512));
  const pngs = [];
  for (const size of SIZES) pngs.push({ size, data: await render(win, size) });
  fs.writeFileSync(path.join(BUILD, "icon.ico"), ico(pngs));
  fs.copyFileSync(path.join(BUILD, "icon.svg"), path.join(__dirname, "..", "renderer", "icon.svg"));
  console.log("wrote icon.png and icon.ico (" + SIZES.join(", ") + ")");
  app.quit();
});
