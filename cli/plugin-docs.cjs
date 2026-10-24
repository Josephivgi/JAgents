"use strict";

module.exports = `# JAgents terminal plugins

Terminal plugins are separate from desktop plugins. They run trusted Node.js
code as your user, with access to files, processes, and the network. Only install
code you trust. Agents may edit plugins when the user asks, not on their own.

Run jagents plugins to list them, or use Ctrl+B e inside the terminal app.
Use jagents plugins docs for this API, and jagents mcp-config for a connection
entry for any MCP client. Claude Code and Codex panes get MCP per launch.
Other agents can connect using the printed entry. A running terminal window is
required. Multiple windows have separate endpoints; panes inherit their own.
The default external connection points to the most recently opened window.

## Files

A folder in the terminal data directory's plugins/<id>:
- plugin.json: { "name": "My tools", "version": "1.0.0", "description": "..." }
- main.cjs: exports.activate = (ctx) => { ...; return () => { /* cleanup */ }; }
- Other CommonJS files and assets.

Do not use desktop renderer.js, style.css, Electron, or browser DOM APIs here.
main.cjs can change terminal behavior, add menu commands and MCP tools, and use
the full Node.js API. Plugins reload live on save. Old versions are kept for
undo. Disable or undo a broken plugin from the Plugins menu or MCP.
JAGENTS_SAFE_MODE=1 jagents starts without user plugins.

Manifest mcpServers adds outside servers to new Claude Code and Codex panes:
{ "mcpServers": { "clock": { "command": "node", "args": ["/path/server.cjs"] } },
  "disableTools": ["clock.dangerous", "jagents-terminal.write_terminal"] }
In-app server tools and terminal tools honor disableTools immediately. Outside
server tool restrictions are forwarded as Claude Code disallowed tools; Codex
uses disabled_tools. Restart panes to pick up new server configuration.

## Main API

- ctx.id, ctx.dir, ctx.dataDir: plugin identity and directories.
- ctx.storage.get(key, fallback), ctx.storage.set(key, value): durable SQLite.
- ctx.log(...), ctx.notify(text), ctx.dispose(cleanup).
- ctx.hub(toolName, args): call a terminal MCP tool as the plugin.
- ctx.terminal.list(): pane metadata, never screen text.
- ctx.terminal.read({id, lines}): plain screen/scrollback (default 120, max 2000).
- ctx.terminal.open({provider:"shell", name, cwd, mode:"tab"|"right"|"down"}).
- ctx.terminal.write({id, text, enter:false}): raw PTY input, enter adds return.
- ctx.terminal.rename({id, name}), focus({id}), close({id}).
- ctx.terminal.settings({sidebar:true, theme:{accent:"151;146;236"}}):
  persist sidebar and RGB theme tokens; omit arguments to read settings.
  Tokens: canvas, surface, well, line, ink, muted, faint, accent, accentInk,
  accentSoft, ok, warn, danger. Empty theme resets defaults.
- ctx.terminal.on(event, callback): terminal-opened, terminal-closed,
  terminal-renamed, terminal-data {id,data}, terminal-exit {id,exitCode}.
  Returns unsubscribe; also removed automatically on plugin unload.
- ctx.terminal.commands.register({id, label, handler}): a Plugins menu action.
  Returns unregister; also removed automatically. Handler may return a promise.
- ctx.mcp.server(name, {description}).tool({name, description, inputSchema,
  handler(args, caller)}): live in-app MCP tools. caller has paneId when known.
  jagents-terminal, jagents and relay are reserved server names.

Timers and subprocesses you create need ctx.dispose cleanup. Plugins are not
sandboxed. Do not print secrets or send terminal text outside the app.

## Example

exports.activate = (ctx) => {
  ctx.terminal.commands.register({
    id: "shell", label: "Open project shell",
    handler: () => ctx.terminal.open({ provider: "shell", name: "Project" })
  });
  ctx.mcp.server("clock", { description: "Time helpers" }).tool({
    name: "now", description: "Current time",
    inputSchema: { type: "object", properties: {} },
    handler: () => ({ iso: new Date().toISOString() })
  });
};

## Dedicated MCP

plugin_docs, list_plugins, read_plugin, write_plugin, set_plugin_enabled,
undo_plugin, delete_plugin, set_safe_mode manage plugins.
list_terminals, open_terminal, read_terminal, write_terminal, rename_terminal,
focus_terminal, close_terminal, terminal_settings control this window.
list_commands and run_command run plugin commands. reload_terminal reloads
the TUI code without stopping panes. Plugin changes apply without a restart;
new MCP server connections require a new agent pane.

Treat close_terminal, write_terminal and plugin code changes as real user
actions. They can stop work or execute commands. Get the user's permission
before destructive actions or actions outside what they asked you to do.
`;
