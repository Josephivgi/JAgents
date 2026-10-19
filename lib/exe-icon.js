"use strict";

// Reads the icon images out of a Windows executable's resources, so JAgents
// can tell whether the exe it runs on carries the JAgents icon (an installed
// JAgents.exe, patched by scripts/icon-resource.cjs) or Electron's own (a
// checkout started with `electron .`). Only the PE headers and the resource
// section are read, not the whole file.

const fs = require("node:fs");
const { readIcon } = require("../scripts/icon-resource.cjs");

const RT_ICON = 3;
const SUBDIR = 0x80000000;

function readAt(fd, offset, length) {
  const buf = Buffer.alloc(length);
  const got = fs.readSync(fd, buf, 0, length, offset);
  return got === length ? buf : buf.subarray(0, got);
}

// Every RT_ICON payload in the exe, as Buffers.
function exeIconImages(exePath) {
  const fd = fs.openSync(exePath, "r");
  try {
    const dos = readAt(fd, 0, 64);
    if (dos.length < 64 || dos.toString("latin1", 0, 2) !== "MZ") throw new Error("not a Windows executable");
    const pe = dos.readUInt32LE(0x3c);
    const head = readAt(fd, pe, 24);
    if (head.toString("latin1", 0, 4) !== "PE\0\0") throw new Error("no PE header");
    const sections = head.readUInt16LE(6);
    const optSize = head.readUInt16LE(20);
    const opt = readAt(fd, pe + 24, optSize);
    const magic = opt.readUInt16LE(0);
    const dirs = magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1;
    if (dirs < 0 || opt.length < dirs + 24) throw new Error("unknown optional header");
    const rsrcRva = opt.readUInt32LE(dirs + 16);
    if (!rsrcRva) return [];
    const table = readAt(fd, pe + 24 + optSize, sections * 40);
    let sec = null;
    for (let i = 0; i < sections; i++) {
      const at = i * 40;
      const va = table.readUInt32LE(at + 12);
      const size = Math.max(table.readUInt32LE(at + 8), table.readUInt32LE(at + 16));
      if (rsrcRva >= va && rsrcRva < va + size) sec = { va, raw: table.readUInt32LE(at + 20), size: table.readUInt32LE(at + 16) };
    }
    if (!sec) throw new Error("resource section not found");
    const rsrc = readAt(fd, sec.raw, sec.size);
    const base = rsrcRva - sec.va;
    const entries = (dirOff) => {
      const count = rsrc.readUInt16LE(base + dirOff + 12) + rsrc.readUInt16LE(base + dirOff + 14);
      const out = [];
      for (let i = 0; i < count; i++) {
        const at = base + dirOff + 16 + i * 8;
        out.push({ id: rsrc.readUInt32LE(at), to: rsrc.readUInt32LE(at + 4) });
      }
      return out;
    };
    const images = [];
    const iconType = entries(0).find((e) => e.id === RT_ICON && e.to & SUBDIR);
    if (!iconType) return images;
    for (const name of entries(iconType.to & ~SUBDIR)) {
      if (!(name.to & SUBDIR)) continue;
      for (const lang of entries(name.to & ~SUBDIR)) {
        if (lang.to & SUBDIR) continue;
        const data = base + lang.to;
        const rva = rsrc.readUInt32LE(data);
        const size = rsrc.readUInt32LE(data + 4);
        const at = rva - sec.va;
        if (at >= 0 && at + size <= rsrc.length) images.push(rsrc.subarray(at, at + size));
      }
    }
    return images;
  } finally {
    fs.closeSync(fd);
  }
}

// True when every image of icoPath is inside the exe, byte for byte.
function exeHasIcon(exePath, icoPath) {
  const ico = fs.readFileSync(icoPath);
  const want = readIcon(icoPath).images.map((i) => ico.subarray(i.offset, i.offset + i.bytes));
  const have = exeIconImages(exePath);
  return want.length > 0 && want.every((w) => have.some((h) => h.length === w.length && h.equals(w)));
}

module.exports = { exeIconImages, exeHasIcon };
