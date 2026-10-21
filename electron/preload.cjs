"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("jagents", {
  appInfo: call("app-info"),
  setSetting: call("set-setting"),
  pickFolder: call("pick-folder"),
  pickFiles: call("pick-files"),
  // The page has drawn the app; until then a stuck start gets reloaded.
  ready: () => ipcRenderer.send("app-ready"),
  // A dropped or pasted File's path on disk ("" for one that has none, such
  // as a pasted screenshot).
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  openPath: call("open-path"),
  openUrl: call("open-url"),
  agents: {
    list: call("agents-list"),
    modelInfo: call("agent-model-info"),
    setModel: call("agent-set-model"),
    probe: call("agent-probe"),
  },
  marketplace: {
    list: call("marketplace-list"),
    add: call("marketplace-add"),
    remove: call("marketplace-remove"),
    install: call("marketplace-install"),
    installs: call("marketplace-installs"),
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
    authenticate: call("chat-authenticate"),
    remove: call("chat-delete"),
  },
  hub: {
    agents: call("hub-agents"),
    activity: call("hub-activity"),
    handoff: call("handoff"),
    mcpStatus: call("mcp-status"),
    install: call("mcp-install"),
    uninstall: call("mcp-uninstall"),
    support: call("mcp-support"),
    autoState: call("mcp-auto-state"),
    autoRun: call("mcp-auto-run"),
    tools: call("hub-tools"),
  },
  legacy: {
    state: call("legacy-state"),
    importData: call("legacy-import"),
  },
  usage: {
    get: call("usage-get"),
    refresh: call("usage-refresh"),
  },
  updates: {
    state: call("update-state"),
    check: call("update-check"),
    apply: call("update-apply"),
    restart: call("app-restart"),
  },
  onEvent(handler) {
    const listener = (_event, msg) => handler(msg);
    ipcRenderer.on("app-event", listener);
    return () => ipcRenderer.removeListener("app-event", listener);
  },
});
