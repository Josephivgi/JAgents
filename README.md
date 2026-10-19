# JAgents

A desktop workspace for coding agents. Run Claude Code, Codex, Devin, Cursor, Gemini and other agents side by side in terminals and chats. The built-in `jagents` MCP server lets them see each other, send messages, read each other's work, start subagents, and hand off context.

## Run

```
npm install
npm start
```

Requires Node.js 22.5 or newer (for `node:sqlite`) and Windows, macOS or Linux.

## Using it

- **Code**: terminals and chats in a split grid.
- **Threads**: every chat thread in a list, one open at full width.
- **Help**: a guide to the JAgents MCP server, with the live tool list and which agents get it.
- **MCP hub** (top bar): connect terminals, Auto MCP, global installs for agents outside the app.
- **Version button** (top bar): shows the running version, checks GitHub releases, installs updates.

## Updates

JAgents checks the latest release of this repo at startup and every 6 hours. When it runs from a git checkout, **Install** fast-forwards to the release tag (and runs `npm install` if packages changed); **Restart JAgents** starts the new version. The repo is private, so the check uses `GITHUB_TOKEN` or your `gh auth login` session.

## Data

- App data: `%APPDATA%\JAgents` (Windows).
- Coming from Relay: **MCP hub > Legacy (development) > Import from legacy Relay**, then restart. It copies your threads, layout, plugins, and MCP setup. Relay's own files are only read.
- Hub files: `~/.jagents` (`hub.json`, `jagents-mcp.cjs`).
