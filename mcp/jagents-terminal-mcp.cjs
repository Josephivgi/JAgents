#!/usr/bin/env node
"use strict";

const os = require("node:os");
const path = require("node:path");

// Independent of the desktop hub. A launched pane gets its own window's file.
process.env.JAGENTS_HUB_FILE = process.env.JAGENTS_TERMINAL_HUB_FILE || path.join(process.env.JAGENTS_TERMINAL_HOME || path.join(os.homedir(), ".jagents", "terminal"), "hub.json");
process.env.JAGENTS_SERVER = "jagents-terminal";
require("./jagents-plugin-mcp.cjs");
