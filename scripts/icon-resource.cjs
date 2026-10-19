"use strict";

// Put the app's icon into a Windows executable's resources.
//
// The installer copies the Electron runtime and renames its launcher to
// "JAgents.exe". Renaming does not change the icon Windows draws in
// Explorer, on the taskbar, or on a shortcut that points at the exe: that
// picture is a resource inside the file, and it stays Electron's atom until
// something rewrites it. Nothing on the install path has a resource
// compiler, so the rewrite goes straight to the Win32 resource API
// (BeginUpdateResource / UpdateResource / EndUpdateResource) through a short
// PowerShell script: no new dependency, no build step, and no binary tool to
// ship.
//
//   const { applyIcon, canPatch, readIcon } = require("./icon-resource.cjs");
//   const result = await applyIcon(exePath, icoPath);   // { ok, error, images }
//
// The exe is only touched by the resource API, which either replaces the
// icon group and its images or leaves the file exactly as it was: a patch
// that fails halfway is discarded, so a bad icon can never cost the app its
// launcher. Windows caches file icons, so a repainted icon can take a
// moment (or a sign-out) to appear on an existing shortcut.

const fssync = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// RT_ICON and RT_GROUP_ICON, from winuser.h, as integer resource types.
const RT_ICON = 3;
const RT_GROUP_ICON = 14;

const PS1 = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.IO;",
  "using System.Runtime.InteropServices;",
  "public class JAgentsIcon {",
  '  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]',
  "  private static extern IntPtr BeginUpdateResource(string fileName, bool deleteExisting);",
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  "  private static extern bool UpdateResource(IntPtr hUpdate, IntPtr type, IntPtr name, ushort language, byte[] data, uint size);",
  '  [DllImport("kernel32.dll", SetLastError = true)]',
  "  private static extern bool EndUpdateResource(IntPtr hUpdate, bool discard);",
  "",
  "  // Replaces the icon group and every RT_ICON image. Returns an empty",
  "  // string on success, or the reason it refused to touch the file.",
  "  public static string Apply(string exePath, string icoPath, int groupId) {",
  "    byte[] ico = File.ReadAllBytes(icoPath);",
  "    if (ico.Length < 6 || BitConverter.ToUInt16(ico, 0) != 0 || BitConverter.ToUInt16(ico, 2) != 1)",
  '      return "not an icon file";',
  "    int count = BitConverter.ToUInt16(ico, 4);",
  "    if (count <= 0 || ico.Length < 6 + count * 16) return \"the icon directory is incomplete\";",
  "    int[] sizes = new int[count];",
  "    int[] offsets = new int[count];",
  "    byte[] group = new byte[6 + count * 14];",
  "    group[2] = 1;",
  "    group[4] = (byte)(count & 0xFF);",
  "    group[5] = (byte)((count >> 8) & 0xFF);",
  "    for (int i = 0; i < count; i++) {",
  "      int at = 6 + i * 16;",
  "      sizes[i] = (int)BitConverter.ToUInt32(ico, at + 8);",
  "      offsets[i] = (int)BitConverter.ToUInt32(ico, at + 12);",
  "      if (sizes[i] <= 0 || offsets[i] <= 0 || offsets[i] + sizes[i] > ico.Length)",
  '        return "the icon directory points past the end of the file";',
  "      int g = 6 + i * 14;",
  "      group[g] = ico[at];",
  "      group[g + 1] = ico[at + 1];",
  "      group[g + 2] = ico[at + 2];",
  "      group[g + 4] = ico[at + 4];",
  "      group[g + 5] = ico[at + 5];",
  "      group[g + 6] = ico[at + 6];",
  "      group[g + 7] = ico[at + 7];",
  "      group[g + 8] = (byte)(sizes[i] & 0xFF);",
  "      group[g + 9] = (byte)((sizes[i] >> 8) & 0xFF);",
  "      group[g + 10] = (byte)((sizes[i] >> 16) & 0xFF);",
  "      group[g + 11] = (byte)((sizes[i] >> 24) & 0xFF);",
  "      group[g + 12] = (byte)((i + 1) & 0xFF);",
  "      group[g + 13] = (byte)(((i + 1) >> 8) & 0xFF);",
  "    }",
  "    IntPtr h = BeginUpdateResource(exePath, false);",
  "    if (h == IntPtr.Zero) return \"BeginUpdateResource failed with \" + Marshal.GetLastWin32Error();",
  "    bool ok = true;",
  "    for (int i = 0; i < count && ok; i++) {",
  "      byte[] image = new byte[sizes[i]];",
  "      Array.Copy(ico, offsets[i], image, 0, sizes[i]);",
  "      ok = UpdateResource(h, (IntPtr)3, (IntPtr)(i + 1), 0, image, (uint)image.Length);",
  "    }",
  "    if (ok) {",
  "      // No attempt to delete an image id this icon does not use: a delete",
  "      // of a resource that is not there fails, and a failed call inside an",
  "      // open update session leaves the group write failing with an",
  "      // internal error. Any image left over from a bigger icon stays in",
  "      // the file unreferenced, which costs bytes and nothing else.",
  "      ok = UpdateResource(h, (IntPtr)14, (IntPtr)groupId, 0, group, (uint)group.Length);",
  "    }",
  "    int last = Marshal.GetLastWin32Error();",
  "    // A failure discards the whole update, so the exe is never half-patched.",
  "    if (!EndUpdateResource(h, !ok))",
  '      return "EndUpdateResource failed with " + Marshal.GetLastWin32Error();',
  "    if (!ok) return \"UpdateResource failed with \" + last;",
  '    return "";',
  "  }",
  "}",
  "'@",
  "$error1 = [JAgentsIcon]::Apply($env:SR_EXE, $env:SR_ICO, 1)",
  "if ($error1) {",
  "  Write-Output ('{\"ok\":false,\"error\":' + (ConvertTo-Json $error1 -Compress) + '}')",
  "} else {",
  "  Write-Output '{\"ok\":true}'",
  "}",
  "",
].join("\r\n");

// The image directory of an .ico: sizes and payload extents, in file order.
function readIcon(file) {
  const ico = fssync.readFileSync(file);
  if (ico.length < 6 || ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) {
    throw new Error(path.basename(file) + " is not a Windows icon");
  }
  const count = ico.readUInt16LE(4);
  if (count <= 0 || ico.length < 6 + count * 16) {
    throw new Error(path.basename(file) + " has an incomplete icon directory");
  }
  const images = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + i * 16;
    const width = ico[at] === 0 ? 256 : ico[at];
    const height = ico[at + 1] === 0 ? 256 : ico[at + 1];
    images.push({ width, height, bytes: ico.readUInt32LE(at + 8), offset: ico.readUInt32LE(at + 12) });
  }
  return { count, images };
}

function canPatch() {
  return process.platform === "win32";
}

// Rewrites exePath's icon group and images from icoPath. Never throws: the
// caller gets { ok, error, images } because a run that cannot paint the icon
// should still install the app.
function applyIcon(exePath, icoPath, opts) {
  const result = { ok: false, error: "", images: 0 };
  const quiet = Boolean(opts && opts.quiet);
  try {
    if (!canPatch()) {
      result.error = "only Windows executables carry icons";
      return result;
    }
    if (!fssync.existsSync(exePath)) {
      result.error = "no executable at " + exePath;
      return result;
    }
    if (!fssync.existsSync(icoPath)) {
      result.error = "no icon at " + icoPath;
      return result;
    }
    const icon = readIcon(icoPath);
    result.images = icon.count;
    const scriptFile = path.join(os.tmpdir(), "jagents-icon-" + process.pid + "-" + Date.now() + ".ps1");
    fssync.writeFileSync(scriptFile, PS1, "utf8");
    let stdout = "";
    try {
      stdout = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile],
        {
          timeout: 60000,
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, SR_EXE: exePath, SR_ICO: icoPath },
        },
      );
    } finally {
      fssync.rmSync(scriptFile, { force: true });
    }
    const line = String(stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (parsed && parsed.ok) {
      result.ok = true;
      return result;
    }
    result.error = (parsed && parsed.error) || line || "the icon could not be written";
    return result;
  } catch (error) {
    result.error = (error && error.message) || String(error);
    if (!quiet) result.error = String(result.error).split(/\r?\n/)[0];
    return result;
  }
}

module.exports = { applyIcon, canPatch, readIcon, RT_ICON, RT_GROUP_ICON };
