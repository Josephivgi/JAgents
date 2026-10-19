"use strict";

// The JAgents icon on the Windows taskbar. Windows draws a window's taskbar
// button (and what gets pinned) from its program: a copy installed by
// JAgents-Setup.exe runs JAgents.exe, which carries the JAgents icon, but a
// checkout started with `electron .` runs electron.exe and shows Electron's
// atom. A running exe cannot be repainted, so for that case JAgents gives its
// windows their own AppUserModelID and a Start Menu shortcut with that ID and
// the JAgents icon; Windows then draws and pins the button from the shortcut.
// Copies whose exe already has the icon are left alone.

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
  const tag = customRoot ? createHash("sha1").update(customRoot.toLowerCase()).digest("hex").slice(0, 8) : "";
  const id = tag ? BASE_ID + "." + tag : BASE_ID;
  const name = customRoot ? "JAgents (" + path.basename(customRoot) + ")" : "JAgents";
  const args = [quote(appRoot)];
  if (customRoot) args.push(quote("--data-root=" + customRoot));
  if (jagentsHome) args.push(quote("--jagents-home=" + jagentsHome));
  app.setAppUserModelId(id);
  const details = { appId: id, appIconPath: icoPath, appIconIndex: 0, relaunchCommand: quote(process.execPath) + " " + args.join(" "), relaunchDisplayName: name };
  const link = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", name + ".lnk");
  const want = { target: process.execPath, args: args.join(" "), cwd: appRoot, icon: icoPath, iconIndex: 0, appUserModelId: id, description: "JAgents" };
  let current = null;
  if (fs.existsSync(link)) {
    try {
      current = shell.readShortcutLink(link);
    } catch {
      current = {};
    }
    // A JAgents shortcut from somewhere else (an installed copy) stays as it is.
    if (current.appUserModelId !== id && current.target && path.resolve(current.target) !== path.resolve(process.execPath)) {
      log("Left " + link + " alone: it opens " + current.target);
      return { status: "shortcut-taken", id, details, link };
    }
  }
  const same = current && Object.keys(want).every((k) => String(current[k] == null ? "" : current[k]).toLowerCase() === String(want[k]).toLowerCase());
  if (!same) {
    const ok = shell.writeShortcutLink(link, current ? "replace" : "create", want);
    if (!ok) {
      log("Could not write " + link);
      return { status: "shortcut-failed", id, details, link };
    }
    log((current ? "Updated " : "Added ") + link + " so the taskbar shows the JAgents icon");
  }
  return { status: "shortcut", id, details, link };
}

module.exports = { setupTaskbarIcon };
