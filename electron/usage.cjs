// Usage: reads each provider's plan limits for whoever runs JAgents.
// Nothing is hardcoded per user: folders come from the provider's own env
// vars or the home folder, sign-in comes from the provider's own store (file
// or OS keychain), and plan names come from the API reply. Tokens are only
// read, never refreshed or written, so each provider stays in charge of its
// own sign-in. A provider that is not installed is left out.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawn, execFile } = require("node:child_process");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const home = os.homedir();
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
const readText = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
};
const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const titleCase = (s) => String(s || "").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const ms = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (/^\d+$/.test(String(v))) return ms(Number(v));
  return Date.parse(v) || 0;
};
const jwtExp = (t) => {
  try {
    return JSON.parse(Buffer.from(String(t).split(".")[1], "base64url")).exp * 1000;
  } catch {
    return 0;
  }
};
const errText = (e) => String(e && e.message ? e.message : e);

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1 << 20 }, (err, out) => resolve(err ? "" : String(out).trim()));
  });
}

// A generic password from the OS keychain. On Windows this reads the
// Credential Manager entry the same way keytar writes it.
async function keychain(service, account) {
  if (process.platform === "darwin") return run("security", ["find-generic-password", "-s", service].concat(account ? ["-a", account] : []).concat(["-w"]), 8000);
  if (process.platform === "linux") return run("secret-tool", ["lookup", "service", service].concat(account ? ["account", account] : []), 8000);
  if (process.platform !== "win32") return "";
  const target = account ? service + "/" + account : service;
  const ps =
    "$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\nusing System;using System.Runtime.InteropServices;public static class JUsageCred{[StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct C{public int Flags;public int Type;public string TargetName;public string Comment;public long LastWritten;public int BlobSize;public IntPtr Blob;public int Persist;public int AttrCount;public IntPtr Attrs;public string Alias;public string User;}[DllImport(\"advapi32.dll\",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CredReadW(string t,int type,int f,out IntPtr p);[DllImport(\"advapi32.dll\")]static extern void CredFree(IntPtr p);public static string Read(string t){IntPtr p;if(!CredReadW(t,1,0,out p))return \"\";try{var c=(C)Marshal.PtrToStructure(p,typeof(C));var b=new byte[c.BlobSize];Marshal.Copy(c.Blob,b,0,c.BlobSize);return Convert.ToBase64String(b);}finally{CredFree(p);}}}\n'@\n[Console]::Out.Write([JUsageCred]::Read($env:JUSAGE_TARGET))";
  const out = await new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], { timeout: 20000, windowsHide: true, env: Object.assign({}, process.env, { JUSAGE_TARGET: target }) }, (err, o) => resolve(err ? "" : String(o).trim()));
  });
  return out ? Buffer.from(out, "base64").toString("utf8") : "";
}

async function getJson(url, headers, init) {
  const r = await fetch(url, Object.assign({ headers, signal: AbortSignal.timeout(15000) }, init || {}));
  if (r.status === 401 || r.status === 403) {
    const e = new Error("signin");
    e.signin = true;
    throw e;
  }
  if (!r.ok) throw new Error(new URL(url).host + " answered " + r.status);
  return r.json();
}

// ---- Claude ----
const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");

async function claude() {
  if (!exists(claudeDir())) return null;
  let raw = readText(path.join(claudeDir(), ".credentials.json"));
  if (!raw && process.platform === "darwin") raw = await keychain("Claude Code-credentials");
  let c = null;
  try {
    c = JSON.parse(raw).claudeAiOauth;
  } catch {}
  const out = { name: "Claude", fix: "Open Claude Code and sign in." };
  if (!c || !c.accessToken) return Object.assign(out, { status: "signin" });
  out.plan = titleCase(c.subscriptionType);
  if (c.expiresAt && c.expiresAt < Date.now()) return Object.assign(out, { status: "signin", fix: "Open Claude Code once to refresh its sign-in." });
  const j = await getJson("https://api.anthropic.com/api/oauth/usage", { Authorization: "Bearer " + c.accessToken, "anthropic-beta": "oauth-2025-04-20" });
  const limits = [];
  if (Array.isArray(j.limits) && j.limits.length) {
    for (const l of j.limits) {
      if (typeof l.percent !== "number") continue;
      const sc = l.scope || {};
      const scope = (sc.model && (sc.model.display_name || sc.model.id)) || "";
      const base = l.group === "session" ? "Session" : l.group === "weekly" ? "Week" : titleCase(l.group || l.kind);
      limits.push({ label: scope ? base + " · " + scope : base, percent: l.percent, resetsAt: ms(l.resets_at), windowMs: l.group === "session" ? 5 * HOUR : l.group === "weekly" ? 7 * DAY : 0 });
    }
  } else {
    if (j.five_hour) limits.push({ label: "Session", percent: j.five_hour.utilization, resetsAt: ms(j.five_hour.resets_at), windowMs: 5 * HOUR });
    if (j.seven_day) limits.push({ label: "Week", percent: j.seven_day.utilization, resetsAt: ms(j.seven_day.resets_at), windowMs: 7 * DAY });
  }
  const ex = j.extra_usage;
  if (ex && ex.is_enabled && typeof ex.utilization === "number") limits.push({ label: "Extra usage", percent: ex.utilization, resetsAt: 0, windowMs: 0 });
  return Object.assign(out, { limits });
}

// ---- Codex: asks the Codex CLI's own app-server, which handles sign-in ----
const codexDir = () => process.env.CODEX_HOME || path.join(home, ".codex");

function codexRpc(timeout) {
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn("codex app-server", { shell: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      return resolve({ missing: true });
    }
    let buf = "";
    const got = {};
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try {
        p.kill();
      } catch {}
      resolve(v);
    };
    const t = setTimeout(() => finish({ error: "Codex did not answer in time." }), timeout);
    const send = (o) => {
      try {
        p.stdin.write(JSON.stringify(o) + "\n");
      } catch {}
    };
    p.on("error", () => finish({ missing: true }));
    p.on("exit", () => finish(Object.keys(got).length ? { error: "Codex stopped early." } : { missing: true }));
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          got[1] = m;
          send({ method: "initialized" });
          send({ id: 2, method: "account/read", params: {} });
          send({ id: 3, method: "account/rateLimits/read" });
        } else if (m.id === 2 || m.id === 3) {
          got[m.id] = m;
          if (got[2] && got[3]) finish(got);
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "jagents-usage", version: "1.1.0" } } });
  });
}

const windowName = (mins) => (!mins ? "" : mins % 10080 === 0 ? (mins === 10080 ? "Week" : mins / 10080 + " weeks") : mins % 1440 === 0 ? (mins === 1440 ? "Day" : mins / 1440 + " days") : mins % 60 === 0 ? mins / 60 + "h" : mins + " min");

async function codex() {
  if (!exists(codexDir())) return null;
  const out = { name: "Codex", fix: "Run codex login." };
  const res = await codexRpc(45000);
  if (res.missing) return Object.assign(out, { status: "error", message: "Codex CLI not found on PATH." });
  if (res.error) return Object.assign(out, { status: "error", message: res.error });
  const acct = res[2] && res[2].result && res[2].result.account;
  if (!acct) return Object.assign(out, { status: "signin" });
  out.plan = titleCase(acct.planType || "");
  if (acct.type === "apiKey") return Object.assign(out, { plan: "API key", limits: [] });
  if (res[3].error) {
    const msg = String(res[3].error.message || "");
    if (/401|unauthor|sign(ing)? in/i.test(msg)) return Object.assign(out, { status: "signin" });
    return Object.assign(out, { status: "error", message: msg.slice(0, 200) });
  }
  const lim = (res[3].result && res[3].result.rateLimits) || {};
  if (lim.planType) out.plan = titleCase(lim.planType);
  out.limits = [
    [lim.primary, "Session"],
    [lim.secondary, "Week"],
  ]
    .filter(([w]) => w && typeof w.usedPercent === "number")
    .map(([w, fb]) => ({ label: windowName(w.windowDurationMins) || fb, percent: w.usedPercent, resetsAt: ms(w.resetsAt), windowMs: (w.windowDurationMins || 0) * 60000 }));
  return out;
}

// ---- Cursor: the Cursor app's own sign-in, read from its state database ----
function cursorDb() {
  const base = process.platform === "win32" ? process.env.APPDATA || path.join(home, "AppData", "Roaming") : process.platform === "darwin" ? path.join(home, "Library", "Application Support") : process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "Cursor", "User", "globalStorage", "state.vscdb");
}

function cursorAuth() {
  const file = cursorDb();
  if (!exists(file)) return null;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const get = (k) => {
      const r = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(k);
      return r ? String(r.value) : "";
    };
    return { token: get("cursorAuth/accessToken"), plan: get("cursorAuth/stripeMembershipType") };
  } finally {
    db.close();
  }
}

async function cursor() {
  if (!exists(cursorDb()) && !exists(path.join(home, ".cursor"))) return null;
  const out = { name: "Cursor", fix: "Open the Cursor app and sign in." };
  let a;
  try {
    a = cursorAuth();
  } catch (e) {
    return Object.assign(out, { status: "error", message: "Could not read Cursor's sign-in: " + errText(e) });
  }
  if (!a || !a.token) return Object.assign(out, { status: "signin" });
  out.plan = titleCase(a.plan);
  if (jwtExp(a.token) && jwtExp(a.token) < Date.now()) return Object.assign(out, { status: "signin", fix: "Open the Cursor app once to refresh its sign-in." });
  const j = await getJson("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", { Authorization: "Bearer " + a.token, "Content-Type": "application/json", "Connect-Protocol-Version": "1" }, { method: "POST", body: "{}" });
  const start = ms(j.billingCycleStart);
  const end = ms(j.billingCycleEnd);
  const win = start && end ? end - start : 0;
  const pu = j.planUsage || {};
  const limits = [];
  if (typeof pu.apiPercentUsed === "number") limits.push({ label: "API", percent: pu.apiPercentUsed, resetsAt: end, windowMs: win });
  if (typeof pu.autoPercentUsed === "number") limits.push({ label: "Auto", percent: pu.autoPercentUsed, resetsAt: end, windowMs: win });
  if (!limits.length && typeof pu.totalPercentUsed === "number") limits.push({ label: "Plan", percent: pu.totalPercentUsed, resetsAt: end, windowMs: win });
  const sl = j.spendLimitUsage || {};
  const cap = sl.individualLimit || sl.pooledLimit;
  const used = cap ? cap - (sl.individualRemaining !== undefined ? sl.individualRemaining : sl.pooledRemaining || 0) : 0;
  if (cap > 0) limits.push({ label: "On-demand", percent: (used / cap) * 100, resetsAt: end, windowMs: win });
  return Object.assign(out, { limits });
}

// ---- Droid (Factory): droid's own encrypted sign-in, key in the OS keychain ----
const factoryDir = () => path.join(home, ".factory");

function decrypt(text, key) {
  const [iv, tag, ct] = String(text).trim().split(":").map((s) => Buffer.from(s, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
}

const keyFrom = (s) => {
  const b = Buffer.from(String(s || "").trim(), "base64");
  return b.length === 32 ? b : null;
};

async function factoryToken() {
  if (process.env.FACTORY_API_KEY) return process.env.FACTORY_API_KEY;
  const dir = factoryDir();
  const sources = [];
  if (exists(path.join(dir, "auth.v2.file"))) sources.push([path.join(dir, "auth.v2.file"), () => keyFrom(readText(path.join(dir, "auth.v2.key")))]);
  if (exists(path.join(dir, "auth.v2.keyring"))) sources.push([path.join(dir, "auth.v2.keyring"), async () => keyFrom(await keychain("Factory CLI", "auth-encryption-key"))]);
  for (const [file, getKey] of sources) {
    const key = await getKey();
    if (!key) continue;
    try {
      const j = decrypt(readText(file), key);
      if (j.access_token) return j.access_token;
    } catch {}
  }
  return "";
}

async function droid() {
  if (!exists(factoryDir())) return null;
  const out = { name: "Droid", fix: "Run droid and sign in." };
  const tok = await factoryToken();
  if (!tok) return Object.assign(out, { status: "signin" });
  if (jwtExp(tok) && jwtExp(tok) < Date.now()) return Object.assign(out, { status: "signin", fix: "Run droid once to refresh its sign-in." });
  const j = await getJson("https://api.factory.ai/api/billing/limits", { Authorization: "Bearer " + tok });
  const names = { fiveHour: ["5h", 5 * HOUR], weekly: ["Week", 7 * DAY], monthly: ["Month", 30 * DAY] };
  const limits = [];
  for (const [tier, set] of Object.entries(j.limits || {})) {
    for (const [k, w] of Object.entries(set || {})) {
      if (!w || typeof w.usedPercent !== "number") continue;
      if (tier !== "standard" && !w.usedPercent) continue; // other tiers only once used
      const [label, win] = names[k] || [titleCase(k), 0];
      limits.push({ label: (tier === "standard" ? "" : titleCase(tier) + " ") + label, percent: w.usedPercent, resetsAt: ms(w.windowEnd), windowMs: win });
    }
  }
  return Object.assign(out, { limits });
}

// ---- OpenCode Go: the Go key OpenCode saved with opencode auth login ----
function opencodeAuth() {
  const dirs = [process.env.XDG_DATA_HOME && path.join(process.env.XDG_DATA_HOME, "opencode"), path.join(home, ".local", "share", "opencode"), process.platform === "darwin" && path.join(home, "Library", "Application Support", "opencode")].filter(Boolean);
  for (const d of dirs) if (exists(path.join(d, "auth.json"))) return readJson(path.join(d, "auth.json")) || {};
  return null;
}

async function opencodeGo() {
  const auth = opencodeAuth();
  if (!auth) return null;
  const go = auth["opencode-go"];
  const key = go && (go.key || go.access);
  if (!key) return null; // OpenCode without a Go subscription: nothing to show
  const out = { name: "OpenCode Go", fix: "Run opencode auth login and pick OpenCode Go." };
  const j = await getJson("https://opencode.ai/zen/go/v1/usage", { Authorization: "Bearer " + key });
  const names = { rolling: ["5h", 5 * HOUR], weekly: ["Week", 7 * DAY], monthly: ["Month", 30 * DAY] };
  const limits = [];
  for (const [k, w] of Object.entries(j.usage || {})) {
    if (!w || typeof w.percent !== "number") continue;
    const [label, win] = names[k] || [titleCase(k), 0];
    limits.push({ label, percent: w.percent, resetsAt: ms(w.resetsAt), windowMs: win, blocked: w.status && w.status !== "ok" });
  }
  return Object.assign(out, { limits });
}

// ---- Polling ----
const PROVIDERS = [
  ["claude", claude, 5],
  ["codex", codex, 15],
  ["cursor", cursor, 5],
  ["droid", droid, 5],
  ["opencode-go", opencodeGo, 5],
];

// Each provider is read on start and then on its own interval; every result
// goes to the window as a "usage" event.
function createUsage({ emit }) {
  const state = {};
  const running = {};
  let timers = [];
  const list = () => PROVIDERS.map(([id]) => state[id]).filter(Boolean);
  const push = () => emit("usage", list());
  function load(id, fn) {
    if (running[id]) return running[id];
    running[id] = Promise.resolve()
      .then(fn)
      .then((v) => (v ? Object.assign({ status: "ok", limits: [] }, v) : null))
      .catch((e) => (e && e.signin ? { name: (state[id] && state[id].name) || titleCase(id), status: "signin", fix: "Sign in again." } : { name: (state[id] && state[id].name) || titleCase(id), status: "error", message: errText(e).slice(0, 200), limits: [] }))
      .then((v) => {
        if (v) {
          v.id = id;
          v.checkedAt = Date.now();
          if (v.status === "signin" && !v.message) v.message = "Sign-in needed. " + (v.fix || "");
          if (!v.limits) v.limits = [];
          // A sign-in error keeps the last good numbers' plan name.
          if (v.status !== "ok" && !v.plan && state[id]) v.plan = state[id].plan;
        }
        state[id] = v;
        running[id] = null;
        push();
      });
    return running[id];
  }
  const all = () => Promise.all(PROVIDERS.map(([id, fn]) => load(id, fn)));
  return {
    list,
    async refresh() {
      await all();
      return list();
    },
    start() {
      if (timers.length) return;
      timers = PROVIDERS.map(([id, fn, min]) => setInterval(() => load(id, fn), min * 60000));
      all();
    },
    stop() {
      timers.forEach(clearInterval);
      timers = [];
    },
  };
}

module.exports = { createUsage };
