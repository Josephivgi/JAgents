"use strict";

// Layout rules for what plugins draw (renderer/js/plugin-layout.js): an
// <svg> icon always draws at the size it is used at and only in its own box, and a native view's
// bounds leave the divider grab zones free.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// The renderer's ES module, loaded as one (the package itself is CommonJS).
const source = fs.readFileSync(path.join(__dirname, "..", "renderer", "js", "plugin-layout.js"), "utf8");
const load = () => import("data:text/javascript;base64," + Buffer.from(source).toString("base64"));

test("a large svg icon is drawn at the icon size, with a viewBox so it scales", async () => {
  const { sizedSvg } = await load();
  const out = sizedSvg('<svg width="64" height="64" xmlns="http://www.w3.org/2000/svg"><rect width="64" height="64"/></svg>', 15);
  assert.match(out, /^<svg[^>]* width="15" height="15">/);
  assert.match(out, /viewBox="0 0 64 64"/);
  assert.doesNotMatch(out.slice(0, out.indexOf(">")), /width="64"/);
  // The rect inside keeps its own size.
  assert.match(out, /<rect width="64" height="64"\/>/);
});

test("an svg icon with no size gets one, and stroke-width is left alone", async () => {
  const { sizedSvg } = await load();
  const out = sizedSvg('  <svg viewBox="0 0 24 24" stroke-width="2"><path d="M0 0"/></svg>', 18);
  assert.match(out, /^<svg viewBox="0 0 24 24" stroke-width="2" width="18" height="18">/);
});

test("single quotes and unitless sizes are replaced too", async () => {
  const { sizedSvg } = await load();
  const out = sizedSvg("<svg width='40px' height=40 viewBox='0 0 4 4'></svg>", 15);
  assert.strictEqual(out, "<svg viewBox='0 0 4 4' width=\"15\" height=\"15\"></svg>");
});

test("an svg icon's inline style cannot size, place or move it", async () => {
  const { sizedSvg } = await load();
  const out = sizedSvg('<svg viewBox="0 0 24 24" style="position:fixed;left:0;top:0;width:200px;height:200px;z-index:9;color:red"><rect/></svg>', 15);
  assert.strictEqual(out, '<svg viewBox="0 0 24 24" style="color:red" width="15" height="15"><rect/></svg>');
  const sized = sizedSvg("<svg viewBox='0 0 24 24' style='width:120px;height:120px'></svg>", 15);
  assert.strictEqual(sized, '<svg viewBox=\'0 0 24 24\' width="15" height="15"></svg>');
});

test("only the first svg element is kept: what follows it is dropped", async () => {
  const { sizedSvg } = await load();
  const out = sizedSvg('<svg viewBox="0 0 24 24"><svg><g/></svg><path d="M0 0"/></svg><div style="position:fixed;width:300px;height:300px"></div>', 15);
  assert.strictEqual(out, '<svg viewBox="0 0 24 24" width="15" height="15"><svg><g/></svg><path d="M0 0"/></svg>');
  assert.strictEqual(sizedSvg('<svg viewBox="0 0 4 4"/><b>x</b>', 15), '<svg viewBox="0 0 4 4" width="15" height="15"/>');
});

test("a native view next to a divider leaves the divider's grab zone free", async () => {
  const { trimRect, splitZone } = await load();
  const split = splitZone({ left: 809, right: 810, top: 0, bottom: 768, width: 1, height: 768 });
  const handle = { left: 249, right: 255, top: 0, bottom: 768 };
  const leftView = trimRect({ left: 252, top: 79, right: 809, bottom: 768 }, [split, handle]);
  assert.deepStrictEqual(leftView, { x: 255, y: 79, width: 551, height: 689 });
  const rightView = trimRect({ left: 810, top: 79, right: 1366, bottom: 768 }, [split, handle]);
  assert.deepStrictEqual(rightView, { x: 813, y: 79, width: 553, height: 689 });
});

test("a horizontal divider trims the view above and below it", async () => {
  const { trimRect, splitZone } = await load();
  const split = splitZone({ left: 252, right: 1366, top: 400, bottom: 401, width: 1114, height: 1 });
  assert.deepStrictEqual(trimRect({ left: 252, top: 79, right: 1366, bottom: 400 }, [split]), { x: 252, y: 79, width: 1114, height: 318 });
  assert.deepStrictEqual(trimRect({ left: 252, top: 401, right: 1366, bottom: 768 }, [split]), { x: 252, y: 404, width: 1114, height: 364 });
  // A divider elsewhere changes nothing.
  assert.deepStrictEqual(trimRect({ left: 900, top: 79, right: 1366, bottom: 300 }, [split]), { x: 900, y: 79, width: 466, height: 221 });
});

test("fractional rects round inward, never back over a grab zone", async () => {
  const { trimRect, splitZone } = await load();
  const split = splitZone({ left: 808.5, right: 809.5, top: 50.7, bottom: 768, width: 1, height: 717.3 });
  const v = trimRect({ left: 252.4, top: 129.6, right: 808.5, bottom: 768 }, [split]);
  assert.deepStrictEqual(v, { x: 253, y: 130, width: 552, height: 638 });
  assert.ok(v.x + v.width <= 805.5);
});

test("a host wider than its pane is cut to the pane, not moved past the divider", async () => {
  const { trimRect, splitZone, clipRect } = await load();
  // Left pane body 252..809, divider at 809, a 3000px host inside the left pane.
  const split = splitZone({ left: 809, right: 810, top: 89, bottom: 768, width: 1, height: 679 });
  const handle = { left: 249, right: 255, top: 0, bottom: 768 };
  const body = { left: 252, top: 89, right: 809, bottom: 288 };
  const v = trimRect(clipRect({ left: 252, top: 89, right: 3252, bottom: 288 }, [body]), [split, handle]);
  assert.deepStrictEqual(v, { x: 255, y: 89, width: 551, height: 199 });
  assert.ok(v.x + v.width <= 806);
});

test("a host taller than its pane stops above the next group's tab strip", async () => {
  const { trimRect, splitZone, clipRect } = await load();
  // Middle-right body 447..588, then a divider at 588 and the next strip.
  const split = splitZone({ left: 810, right: 1366, top: 588, bottom: 589, width: 556, height: 1 });
  const body = { left: 810, top: 447, right: 1366, bottom: 588 };
  const v = trimRect(clipRect({ left: 810, top: 447, right: 1366, bottom: 1847 }, [body]), [split]);
  assert.deepStrictEqual(v, { x: 810, y: 447, width: 556, height: 138 });
});

test("a host scrolled partly above its pane starts at the pane's top", async () => {
  const { trimRect, splitZone, clipRect } = await load();
  const split = splitZone({ left: 810, right: 1366, top: 588, bottom: 589, width: 556, height: 1 });
  const body = { left: 810, top: 627, right: 1366, bottom: 768 };
  const v = trimRect(clipRect({ left: 810, top: 547, right: 1366, bottom: 787 }, [body]), [split]);
  assert.deepStrictEqual(v, { x: 810, y: 627, width: 556, height: 141 });
});

test("a host scrolled out of its pane gets no room at all", async () => {
  const { trimRect, clipRect } = await load();
  const body = { left: 810, top: 627, right: 1366, bottom: 768 };
  const v = trimRect(clipRect({ left: 810, top: 100, right: 1366, bottom: 400 }, [body]), []);
  assert.strictEqual(v.height, 0);
  const w = trimRect(clipRect({ left: 1400, top: 627, right: 1600, bottom: 700 }, [body, { left: 0, top: 0, right: 1366, bottom: 768 }]), []);
  assert.strictEqual(w.width, 0);
});
