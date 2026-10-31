// Layout rules JAgents applies to what plugins draw, kept free of the DOM so
// tests can run them: icon sizing and native view bounds.

// A plugin's <svg> string draws at the icon size it is used at, whatever
// width and height it carries (a 64px svg in a 15px dock button covered its
// neighbours; one with no size shrank to nothing). A sized svg without a
// viewBox gets one, so its drawing scales instead of being cropped. Only the
// first <svg> element is kept: anything after it (a stray <div>) is dropped,
// and its inline style loses size, position and offsets, so an icon can only
// draw in its own box.
const LAYOUT_PROPS = /^(position|inset(-.*)?|top|right|bottom|left|(min-|max-)?(width|height)|(min-|max-)?(block|inline)-size|margin(-.*)?|transform|translate|scale|rotate|zoom|z-index|float)$/i;

function svgEnd(text) {
  // Index just past the </svg> that closes the root, or -1 when it never closes.
  const re = /<svg\b[^>]*?(\/?)>|<\/svg\s*>/gi;
  let depth = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m[0][1] === "/") depth--;
    else if (!m[1]) depth++;
    if (depth <= 0) return re.lastIndex;
  }
  return -1;
}

function layoutFreeStyle(attrs) {
  return attrs.replace(/\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i, (m, q, dq, sq) => {
    const kept = String(dq != null ? dq : sq)
      .split(";")
      .map((d) => d.trim())
      .filter((d) => d && !LAYOUT_PROPS.test(d.split(":")[0].trim()));
    return kept.length ? ' style="' + kept.join("; ").replace(/"/g, "'") + '"' : "";
  });
}

export function sizedSvg(svg, size) {
  const px = Number(size) || 16;
  let text = String(svg).replace(/^\s+/, "");
  const end = svgEnd(text);
  if (end > 0) text = text.slice(0, end);
  return text.replace(/^<svg\b([^>]*?)(\/?)>/i, (m, attrs, selfClose) => {
    let a = layoutFreeStyle(attrs);
    const w = /\swidth\s*=\s*["']?([\d.]+)/i.exec(a);
    const h = /\sheight\s*=\s*["']?([\d.]+)/i.exec(a);
    if (!/\sviewBox\s*=/i.test(a) && w && h) a += ' viewBox="0 0 ' + w[1] + " " + h[1] + '"';
    a = a.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
    return "<svg" + a + ' width="' + px + '" height="' + px + '"' + selfClose + ">";
  });
}

// The part of rect that shows inside every box in clips (the pane body, a
// scrolled plugin pane, main.main, the window): a native view never goes
// past them, whatever size the element it follows has. All are {left, top,
// right, bottom}; an empty result has right === left or bottom === top.
export function clipRect(rect, clips) {
  let { left, top, right, bottom } = rect;
  for (const c of clips || []) {
    left = Math.max(left, c.left);
    top = Math.max(top, c.top);
    right = Math.min(right, c.right);
    bottom = Math.min(bottom, c.bottom);
  }
  return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
}

// Native views take the mouse, so one that runs up to a divider leaves only
// its 1px line to grab. rect and zones are {left, top, right, bottom}; a zone
// taller than wide is a vertical grab zone. Returns {x, y, width, height}
// in whole pixels with the zones next to the rect's edges cut off.
export function trimRect(rect, zones) {
  let { left, top, right, bottom } = rect;
  for (const z of zones) {
    if (right <= left || bottom <= top) break;
    if (z.right <= left || z.left >= right || z.bottom <= top || z.top >= bottom) continue;
    if (z.bottom - z.top >= z.right - z.left) {
      if ((z.left + z.right) / 2 < (left + right) / 2) left = Math.max(left, z.right);
      else right = Math.min(right, z.left);
    } else if ((z.top + z.bottom) / 2 < (top + bottom) / 2) top = Math.max(top, z.bottom);
    else bottom = Math.min(bottom, z.top);
  }
  // Whole pixels, rounded inward, so rounding never puts the view back over a zone.
  const x = Math.ceil(left);
  const y = Math.ceil(top);
  return { x, y, width: Math.max(0, Math.floor(right) - x), height: Math.max(0, Math.floor(bottom) - y) };
}

// A divider is 1px; its grab zone reaches 3px past it on both sides.
export function splitZone(r) {
  return r.width <= r.height ? { left: r.left - 3, right: r.right + 3, top: r.top, bottom: r.bottom } : { left: r.left, right: r.right, top: r.top - 3, bottom: r.bottom + 3 };
}
