# JAgents

A desktop workspace for coding agents. Run Claude Code, Codex, Devin, Cursor, Gemini and other agents side by side in terminals and chats. The built-in `jagents` MCP server lets them see each other, send messages, read each other's work, start subagents, and hand off context.

## Install on Windows

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/Josephivgi/JAgents/main/install.ps1 | iex
```

It asks yes or no for each JSystems app (Simple Recorder, JAgents, JPerformance, JServer, JMCP, JVoice), then downloads the ones you picked from their latest GitHub release, adds them to the Start Menu, pins them to the taskbar, and opens them. An app you already have can be updated or reinstalled; its data is backed up first. No administrator rights are needed, and Windows does not show the "Windows protected your PC" warning. The first time, Windows asks once for permission to add taskbar pins. To install all of them with no questions:

```powershell
$env:JSYSTEMS_APPS='all'; irm https://raw.githubusercontent.com/Josephivgi/JAgents/main/install.ps1 | iex
```

## Terminal app

JAgents also runs in a terminal: many agent terminals (Claude Code, Codex, a shell and the rest JAgents finds) in one window, with tabs, a sidebar and splits. The installer above also installs it when Node.js 22 or newer is on your computer. To install only the terminal app:

```powershell
irm https://raw.githubusercontent.com/Josephivgi/JAgents/main/install-terminal.ps1 | iex
```

Then run `jagents`, or `jagents claude` to open with Claude Code in the first tab. `jagents --list` shows the agents it found, and `jagents update` updates it.

## Run

```
npm install
npm start
```

Requires Node.js 22.5 or newer (for `node:sqlite`) and Windows, macOS or Linux.

## Inside JWorkspace

JWorkspace (the JSystems workspace app) can run this folder as **JAgents Desktop**, in its ADE section next to the JAgents terminal app. In JWorkspace, open **Apps**, add this folder, and restart JWorkspace once so it registers the `jagents-app` page scheme. `jworkspace.json` describes the app; `electron/jworkspace.cjs` starts the same backend the desktop app runs (`electron/backend.cjs`).

- It uses the desktop app's data (`%APPDATA%\JAgents`, `~/.jagents`, or `JAGENTS_DATA_ROOT` and `JAGENTS_HOME`): the same threads, terminals, plugins, hub and browser sign-ins. Only one JAgents can have that data open. While the desktop app is open, JWorkspace shows "JAgents Desktop is open in its own window. Close it, then press Reload." Opening the desktop app (this version or later) while JWorkspace has the data brings JWorkspace's JAgents Desktop page forward instead. Older desktop builds (0.6.5 and earlier) do not know about this and take the terminal service over; JWorkspace's copy then stops without saving, so it does not overwrite their data. Once JAgents Desktop used its browser inside JWorkspace, the browser data stays open until JWorkspace quits, so the desktop app says to quit JWorkspace first even after a Stop.
- It does not install updates itself: it runs the folder JWorkspace loaded, so update that folder. **Restart JAgents** reloads it in place; terminals keep running.
- JWorkspace's hidden test runs (`--smoke`, `--home`) give it scratch data and turn off Auto MCP.

## Using it

- **Code**: terminals and chats in a split grid.
- **Threads**: every chat thread in a list, one open at full width.
- **Subagents**: every agent's subagents, grouped by parent. Agents start them with the built-in `subagents` MCP server (Claude Code, Codex, Droid, Cursor, Devin, Gemini, OpenCode and other installed agents). Only the parent can message or stop its subagents. **Settings** turns subagents on or off (all, or per provider) and sets each provider's default model and effort. It takes the old Help tab's place.
- **Browser**: **+ > Browser** opens a browser pane. Agents drive the same page with the built-in `browser` MCP server.
- **Effort**: chats show an Effort picker next to the model for agents that have one (Claude Code, Cursor, Droid, OpenCode, pi). The pick is kept per chat.
- **MCP hub** (top bar): connect terminals, Auto MCP, global installs for agents outside the app.
- **Version button** (top bar): shows the running version, checks GitHub releases, installs updates.

## Updates

Windows users can install from **JAgents-Setup.exe** on the latest release (also at https://jsystems.app/jagents). It installs per user to `%LOCALAPPDATA%\Programs\JAgents`, no admin. `.github/workflows/setup.yml` builds it for every published release; `node scripts/pack-setup.cjs [tag]` builds it locally (needs NSIS).


JAgents checks the latest release of this repo at startup and every 6 hours. When it runs from a git checkout, **Install** fast-forwards to the release tag (and runs `npm install` if packages changed); **Restart JAgents** starts the new version. The repo is private, so the check uses `GITHUB_TOKEN` or your `gh auth login` session.

## Data

- App data: `%APPDATA%\JAgents` (Windows).
- Coming from Relay: **MCP hub > Legacy (development) > Import from legacy Relay**, then restart. It copies your threads, layout, plugins, and MCP setup. Relay's own files are only read.
- Hub files: `~/.jagents` (`hub.json`, `jagents-mcp.cjs`).
- One JAgents per data folder: the app that has it open holds the named pipe `\\.\pipe\jagents-owner-<hash>` (`electron/owner-lock.cjs`).

## Test

```
npm test
```

`electron . --smoke` runs the desktop app hidden with scratch data: set `JAGENTS_DATA_ROOT` and `JAGENTS_HOME` to scratch folders first (it refuses to run without them). It loads the page, runs `test/fixtures/page-check.js` in it (app info, a terminal round trip through the pty daemon), prints JSON and quits. `--smoke-hold=<ms>` (at most 60 s) keeps it open that much longer, still owning its data folder, so a test can try a second JAgents on the same data. `electron test/fixtures/jworkspace-host.cjs --scratch=<folder>` loads `electron/jworkspace.cjs` the way JWorkspace does, in a hidden window, and checks the owner guard, start, a close while it starts, reload and stop.

## License

MIT. See [LICENSE](LICENSE).
