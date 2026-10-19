"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("relay", {
  appInfo: call("app-info"),
  setSetting: call("set-setting"),
  pickFolder: call("pick-folder"),
  openPath: call("open-path"),
  agents: {
    list: call("agents-list"),
    modelInfo: call("agent-model-info"),
    setModel: call("agent-set-model"),
    probe: call("agent-probe"),
  },
  panes: {
    list: call("panes-list"),
    addTerminal: call("pane-add-terminal"),
    addChat: call("pane-add-chat"),
    remove: call("pane-remove"),
    reorder: call("pane-reorder"),
    addPlugin: call("pane-add-plugin"),
    updatePlugin: call("pane-plugin-update"),
  },
  plugins: {
    list: call("plugins-list"),
    read: call("plugins-read"),
    write: call("plugins-write"),
    setEnabled: call("plugins-enable"),
    undo: call("plugins-undo"),
    remove: call("plugins-remove"),
    scaffold: call("plugins-scaffold"),
    report: call("plugins-report"),
    invoke: call("plugins-invoke"),
    setSafeMode: call("plugins-safe"),
    openFolder: call("plugins-open-folder"),
    storageGet: call("plugins-storage-get"),
    storageSet: call("plugins-storage-set"),
  },
  pty: {
    attach: call("pty-attach"),
    restart: call("pty-restart"),
    write: (id, data) => ipcRenderer.send("pty-write", id, data),
    resize: (id, cols, rows) => ipcRenderer.send("pty-resize", id, cols, rows),
  },
  chats: {
    list: call("chats-list"),
    get: call("chat-get"),
    create: call("chat-create"),
    prompt: call("chat-prompt"),
    cancel: call("chat-cancel"),
    setModel: call("chat-set-model"),
    handoff: call("chat-handoff"),
    remove: call("chat-delete"),
  },
  hub: {
    agents: call("hub-agents"),
    activity: call("hub-activity"),
    handoff: call("handoff"),
    mcpStatus: call("mcp-status"),
    install: call("mcp-install"),
    uninstall: call("mcp-uninstall"),
  },
  onEvent(handler) {
    const listener = (_event, msg) => handler(msg);
    ipcRenderer.on("app-event", listener);
    return () => ipcRenderer.removeListener("app-event", listener);
  },
});
