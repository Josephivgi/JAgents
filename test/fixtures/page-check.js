// Runs inside the JAgents page and drives JAgents through its own preload API,
// as a person would: app-info, then a shell terminal in the real pty daemon
// that prints what it was given and exits with code 7. Used by the desktop
// app's hidden smoke run (electron/smoke.cjs), the JWorkspace load check
// (test/fixtures/jworkspace-host.cjs) and JWorkspace's --app-eval. The value
// of this file is a promise of the result.
(async () => {
  const api = window.jagents;
  const info = await api.appInfo();
  const seen = { data: "", exit: null };
  let pane = null;
  const off = api.onEvent((e) => {
    if (!pane || !e || !e.payload || e.payload.id !== pane.id) return;
    if (e.type === "pty-data") seen.data += e.payload.data;
    if (e.type === "pty-exit") seen.exit = e.payload.exitCode;
  });
  const until = async (test, ms) => {
    const end = Date.now() + ms;
    while (!test()) {
      if (Date.now() > end) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
    return true;
  };
  const plain = () => seen.data.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "");
  try {
    pane = await api.panes.addTerminal({ provider: "shell", cwd: info.dataRoot, title: "Smoke", size: { cols: 160, rows: 30 } });
    const snap = await api.pty.attach(pane.id, { cols: 160, rows: 30 });
    if (snap && snap.data) seen.data += snap.data;
    const prompt = await until(() => /PS [^\r\n]*>/.test(plain()), 20000);
    // PowerShell: the variables the terminal got; a leaked Claude Code session marker shows up here.
    api.pty.write(pane.id, '$a=$env:CLAUDECODE;$b=$env:NO_COLOR;$c=$env:JAGENTS_PANE_ID;"CC=[$a] NC=[$b] PANE=[$c]";exit 7\r');
    const exited = await until(() => seen.exit !== null, 20000);
    const m = /CC=\[([^$\]"]*)\] NC=\[([^$\]"]*)\] PANE=\[([^$\]"]*)\]/.exec(plain());
    const panes = await api.panes.list();
    await api.panes.remove(pane.id, { confirmed: true });
    const terminal = { pane: pane.id, prompt, exited, exitCode: seen.exit, printed: Boolean(m), claudecode: m ? m[1] : null, noColor: m ? m[2] : null, paneId: m ? m[3] : null, listed: panes.some((p) => p.id === pane.id) };
    const ok = exited && seen.exit === 7 && Boolean(m) && m[1] === "" && m[2] === "" && m[3] === pane.id;
    return { ok, host: info.host, version: info.version, dataRoot: info.dataRoot, hubDir: info.hubDir, platform: info.platform, terminal, tail: ok ? undefined : plain().slice(-600) };
  } finally {
    off();
  }
})();
