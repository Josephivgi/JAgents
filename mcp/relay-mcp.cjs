#!/usr/bin/env node
"use strict";

// Relay MCP server (stdio). Self-contained on purpose: Relay copies this file
// to ~/.relay-ade/relay-mcp.cjs so agents keep working if the app folder moves.
// It speaks MCP over newline-delimited JSON-RPC and forwards every tool call to
// the hub inside the running Relay app (loopback HTTP, bearer token from
// hub.json). The caller is identified by RELAY_PANE_ID, which Relay sets for
// every pane it launches; without it the hub matches this process's parent
// chain against its panes.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const HOME_DIR = path.join(os.homedir(), ".relay-ade");
const HUB_FILE = process.env.RELAY_HUB_FILE || path.join(HOME_DIR, "hub.json");
const TOOLS_CACHE = path.join(path.dirname(HUB_FILE), "tools.json");
const PANE_ID = process.env.RELAY_PANE_ID || "";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function hubRequest(method, route, body, timeoutMs) {
  const hub = readJson(HUB_FILE);
  if (!hub || !hub.port || !hub.token) return Promise.reject(new Error("Relay is not running. Open the Relay app, then try again."));
  const payload = body ? JSON.stringify(body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: hub.port,
        path: route,
        method,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Authorization: "Bearer " + hub.token },
        timeout: timeoutMs || 15 * 60 * 1000,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            /* not json */
          }
          if (res.statusCode >= 400) return reject(new Error((json && json.error) || "Relay hub error " + res.statusCode));
          resolve(json);
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Relay hub timed out.")));
    req.on("error", (e) => reject(new Error(e.code === "ECONNREFUSED" ? "Relay is not running. Open the Relay app, then try again." : e.message)));
    req.end(payload);
  });
}

function caller() {
  return { paneId: PANE_ID, pid: process.pid, ppid: process.ppid };
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function listTools() {
  try {
    const out = await hubRequest("GET", "/tools", null, 5000);
    if (out && Array.isArray(out.tools)) return out.tools;
  } catch {
    /* fall back to the cache the hub wrote last time */
  }
  const cached = readJson(TOOLS_CACHE);
  return cached && Array.isArray(cached.tools) ? cached.tools : [];
}

async function callTool(name, args) {
  try {
    const out = await hubRequest("POST", "/call", { caller: caller(), name, args: args || {} });
    const text = typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2);
    return { content: [{ type: "text", text }], isError: false };
  } catch (error) {
    return { content: [{ type: "text", text: String(error.message || error) }], isError: true };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    if (method === "initialize") {
      const asked = params && params.protocolVersion;
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "relay", version: "0.1.0" },
          instructions:
            "Relay connects you to the other coding agents running in the Relay ADE. Use list_agents to see them, send_message to talk to one, read_agent to see what one is doing, spawn_subagent to start an ACP agent (Devin, Cursor, Claude Code, Codex, Gemini) on a task, and handoff_context to pass your context to another agent.",
        },
      });
    }
    if (method === "ping") return isRequest && send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: await listTools() } });
    if (method === "tools/call") return send({ jsonrpc: "2.0", id, result: await callTool(params && params.name, params && params.arguments) });
    if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [] } });
    if (method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { prompts: [] } });
    if (!isRequest) return;
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (error) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(error.message || error) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (Array.isArray(msg)) msg.forEach(handle);
    else handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
