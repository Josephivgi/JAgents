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
// The ID carries a hash of the folder JAgents runs from, so copies in
// different folders never share one.
//
// Windows resolves an ID to one shortcut. Any other shortcut carrying our ID
// (an "Electron.lnk" pointing at the bare electron.exe with no icon turns up
// this way) can win, and the button then shows no JAgents icon. check() runs
// every 30 seconds: it removes such shortcuts and restores ours if it is gone
// or changed, so a broken icon fixes itself.

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { exeHasIcon } = require("../lib/exe-icon");

const BASE_ID = "JAgents.Desktop";

function quote(s) {
  return '"' + s + '"';
}

function readLink(shell, link) {
  try {
    return shell.readShortcutLink(link);
  } catch {
    return {};
  }
}

function samePath(a, b) {
  return !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
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
  const result = { status: "shortcut-taken", id, details: null, link: "", check };

  // Shortcuts other than ours that carry our ID and open this same exe.
  // Ones that open another program are left alone.
  function removeStrays() {
    let removed = 0;
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".lnk"));
    } catch {
      return 0;
    }
    for (const name of names) {
      const link = path.join(dir, name);
      if (samePath(link, result.link)) continue;
      const current = readLink(shell, link);
      if (current.appUserModelId !== id || !samePath(current.target, process.execPath)) continue;
      try {
        fs.rmSync(link, { force: true });
        removed++;
        log("Removed " + link + ": it carried the JAgents taskbar ID without the JAgents icon");
      } catch (error) {
        log("Could not remove " + link + ": " + error.message);
      }
    }
    return removed;
  }

  // Writes our shortcut when it is missing or differs. Returns true when it
  // wrote one.
  function ensureShortcut() {
    // A shortcut that opens another copy (an installed one, or another checkout)
    // stays as it is; this copy then gets one named after its folder, since a
    // window whose ID no shortcut carries gets no icon at all.
    for (const name of [base, base + " (" + path.basename(appRoot) + ")"]) {
      const link = path.join(dir, name + ".lnk");
      let current = null;
      if (fs.existsSync(link)) {
        current = readLink(shell, link);
        if (current.appUserModelId !== id && current.target && !samePath(current.target, process.execPath)) {
          if (!result.link) log("Left " + link + " alone: it opens " + current.target);
          continue;
        }
      }
      result.details = { appId: id, appIconPath: icoPath, appIconIndex: 0, relaunchCommand: quote(process.execPath) + " " + args.join(" "), relaunchDisplayName: name };
      result.link = link;
      const same = current && Object.keys(want).every((k) => String(current[k] == null ? "" : current[k]).toLowerCase() === String(want[k]).toLowerCase());
      if (same) {
        result.status = "shortcut";
        return false;
      }
      // A shortcut whose ID changes is recreated, not replaced: Windows only
      // picks up the new ID from a new file.
      if (current && current.appUserModelId !== id) fs.rmSync(link, { force: true });
      const ok = shell.writeShortcutLink(link, fs.existsSync(link) ? "replace" : "create", want);
      if (!ok) {
        log("Could not write " + link);
        result.status = "shortcut-failed";
        return false;
      }
      log((current ? "Updated " : "Added ") + link + " so the taskbar shows the JAgents icon");
      result.status = "shortcut";
      return true;
    }
    result.status = "shortcut-taken";
    result.details = null;
    result.link = "";
    return false;
  }

  // Returns true when something was repaired, so open windows can re-apply
  // their app details.
  function check() {
    try {
      const wrote = ensureShortcut();
      const removed = result.link ? removeStrays() : 0;
      return wrote || removed > 0;
    } catch (error) {
      log("Taskbar icon check failed: " + error.message);
      return false;
    }
  }

  check();
  if (result.details) app.setAppUserModelId(id);
  return result;
}

module.exports = { setupTaskbarIcon };
