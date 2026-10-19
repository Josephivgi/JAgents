#!/usr/bin/env node
"use strict";

// Bridge for MCP servers that Relay plugins run inside the app (ctx.mcp.server
// in a plugin's main.cjs). Each agent gets one copy of this stdio server per
// plugin server; RELAY_SERVER names which one. Tool lists and calls go to the
// Relay hub (loopback HTTP, bearer token from hub.json), which runs the
// plugin's handlers. Self-contained like relay-mcp.cjs: Relay copies it to
// ~/.relay-ade so agents keep working if the app folder moves.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const HUB_FILE = process.env.RELAY_HUB_FILE || path.join(os.homedir(), ".relay-ade", "hub.json");
const SERVER = process.env.RELAY_SERVER || "";
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

const base = "/servers/" + encodeURIComponent(SERVER);

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function listTools() {
  try {
    const out = await hubRequest("GET", base + "/tools", null, 5000);
    return out && Array.isArray(out.tools) ? out.tools : [];
  } catch {
    return [];
  }
}

async function callTool(name, args) {
  try {
    const out = await hubRequest("POST", base + "/call", { caller: { paneId: PANE_ID, pid: process.pid, ppid: process.ppid }, name, args: args || {} });
    const r = out ? out.result : null;
    // A handler may return MCP content itself ({content: [...]}); anything else becomes text.
    if (r && Array.isArray(r.content)) return { content: r.content, isError: Boolean(r.isError) };
    const text = typeof r === "string" ? r : JSON.stringify(r === undefined ? null : r, null, 2);
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
      let instructions = "";
      try {
        const info = await hubRequest("GET", base + "/tools", null, 5000);
        instructions = (info && info.description) || "";
      } catch {
        /* Relay not running yet */
      }
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER || "relay-plugin", version: "1.0.0" },
          instructions: instructions || "Tools added by a Relay plugin.",
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
