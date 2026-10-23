# JAgents

A desktop workspace for coding agents. Run Claude Code, Codex, Devin, Cursor, Gemini and other agents side by side in terminals and chats. The built-in `jagents` MCP server lets them see each other, send messages, read each other's work, start subagents, and hand off context.

## Install on Windows

Open PowerShell and run:

```powershell
irm https://raw.githubusercontent.com/Josephivgi/JAgents/main/install.ps1 | iex
```

It asks yes or no for each JSystems app (Simple Recorder, JAgents, JPerformance, JServer), then downloads the ones you picked from their latest GitHub release, adds them to the Start Menu, and pins them to the taskbar. No administrator rights are needed, and Windows does not show the "Windows protected your PC" warning. The first time, Windows asks once for permission to add taskbar pins. To install all of them with no questions:

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

## License

MIT. See [LICENSE](LICENSE).
