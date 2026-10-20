"use strict";

// The JAgents icon on the Windows taskbar. Windows draws a window's taskbar
// button (and what gets pinned) from its program: a copy installed by
// JAgents-Setup.exe runs JAgents.exe, which carries the JAgents icon, but a
// checkout started with `electron .` runs electron.exe and shows Electron's
// atom. A running exe cannot be repainted, so for that case JAgents gives its
// windows their own AppUserModelID and a Start Menu shortcut with that ID and
// the JAgents icon; Windows then draws and pins the button from the shortcut.
// Copies whose exe already has the icon are left alone.
//
// The ID carries a hash of the folder JAgents runs from. Windows caches what
// it learns about an ID, and copies in different folders that shared one ID
// left it cached as "Electron" with no JAgents icon.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { exeHasIcon } = require("../lib/exe-icon");

const BASE_ID = "JAgents.Desktop";

function quote(s) {
  return '"' + s + '"';
}

// customRoot: the data folder when it is not the default one (a second,
// separate JAgents); its shortcut carries the folder so it opens that data.
function setupTaskbarIcon({ app, shell, appRoot, icoPath, customRoot, jagentsHome, log }) {
  if (process.platform !== "win32") return { status: "not-windows" };
  try {
    if (exeHasIcon(process.execPath, icoPath)) return { status: "exe-has-icon" };
  } catch (error) {
    log("Could not read the icon of " + process.execPath + ": " + error.message);
  }
  const tag = createHash("sha1").update((customRoot || path.resolve(appRoot)).toLowerCase()).digest("hex").slice(0, 8);
  const id = BASE_ID + "." + tag;
  const base = customRoot ? "JAgents (" + path.basename(customRoot) + ")" : "JAgents";
  const args = [quote(appRoot)];
  if (customRoot) args.push(quote("--data-root=" + customRoot));
  if (jagentsHome) args.push(quote("--jagents-home=" + jagentsHome));
  const want = { target: process.execPath, args: args.join(" "), cwd: appRoot, icon: icoPath, iconIndex: 0, appUserModelId: id, description: "JAgents" };
  const dir = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs");
  // A shortcut that opens another copy (an installed one, or another checkout)
  // stays as it is; this copy then gets one named after its folder, since a
  // window whose ID no shortcut carries gets no icon at all.
  for (const name of [base, base + " (" + path.basename(appRoot) + ")"]) {
    const details = { appId: id, appIconPath: icoPath, appIconIndex: 0, relaunchCommand: quote(process.execPath) + " " + args.join(" "), relaunchDisplayName: name };
    const link = path.join(dir, name + ".lnk");
    let current = null;
    if (fs.existsSync(link)) {
      try {
        current = shell.readShortcutLink(link);
      } catch {
        current = {};
      }
      if (current.appUserModelId !== id && current.target && path.resolve(current.target) !== path.resolve(process.execPath)) {
        log("Left " + link + " alone: it opens " + current.target);
        continue;
      }
    }
    const same = current && Object.keys(want).every((k) => String(current[k] == null ? "" : current[k]).toLowerCase() === String(want[k]).toLowerCase());
    if (!same) {
      // A shortcut whose ID changes is recreated, not replaced: Windows only
      // picks up the new ID from a new file.
      if (current && current.appUserModelId !== id) fs.rmSync(link, { force: true });
      const ok = shell.writeShortcutLink(link, fs.existsSync(link) ? "replace" : "create", want);
      if (!ok) {
        log("Could not write " + link);
        return { status: "shortcut-failed", id, details, link };
      }
      log((current ? "Updated " : "Added ") + link + " so the taskbar shows the JAgents icon");
    }
    app.setAppUserModelId(id);
    return { status: "shortcut", id, details, link };
  }
  return { status: "shortcut-taken", id, details: null, link: "" };
}

module.exports = { setupTaskbarIcon };
