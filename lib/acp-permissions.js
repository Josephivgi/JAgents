// ACP permission answers, adapted from Cutline desktop. Each chat has a
// permission mode that decides which requests JAgents answers by itself and
// which ones wait on the user's pick from the agent's own options:
//   ask    every request the agent sends waits on the user
//   edits  reads, edits and searches are allowed; commands and the rest ask
//   auto   every request is allowed once
//   full   every request is allowed, "always" when the agent offers it
// File reads and writes go through the client fs handlers.

const PERMISSION_MODES = ["ask", "edits", "auto", "full"];
// Tool kinds "Accept edits" allows without asking.
const EDIT_KINDS = new Set(["read", "edit", "search", "think", "fetch"]);

function normalMode(mode) {
  return PERMISSION_MODES.includes(mode) ? mode : "ask";
}

function optionIdOf(option) {
  return String(option && (option.optionId || option.id || option.value) || "").trim();
}

function optionKind(option) {
  return String((option && option.kind) || "").toLowerCase();
}

function optionSignal(option) {
  return (
    optionIdOf(option) +
    " " +
    optionKind(option) +
    " " +
    String((option && (option.name || option.label || option.title)) || "")
  ).toLowerCase();
}

function listPermissionOptions(params) {
  const p = params || {};
  const buckets = [
    p.options,
    p.permissionOptions,
    p.toolCall && p.toolCall.options,
    p.toolCall && p.toolCall.permissionOptions,
    p.tool_call && p.tool_call.options,
  ];
  let raw = [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket) && bucket.length) {
      raw = bucket;
      break;
    }
  }
  const expanded = [];
  for (const option of raw) {
    if (option && Array.isArray(option.options) && option.options.length) {
      expanded.push.apply(expanded, option.options);
    } else {
      expanded.push(option);
    }
  }
  return expanded
    .map((option) => ({
      optionId: optionIdOf(option),
      kind: optionKind(option),
      name: (option && (option.name || option.label || option.title)) || "",
      raw: option,
    }))
    .filter((option) => option.optionId);
}

function isReject(option) {
  return /reject|deny|cancel/.test(optionSignal(option));
}

function pickAllowOnceId(params) {
  const options = listPermissionOptions(params);
  const once =
    options.find((option) => option.kind === "allow_once") ||
    options.find((option) => /allow_once|allow once/.test(optionSignal(option))) ||
    options.find((option) => !isReject(option));
  return (once && once.optionId) || "allow_once";
}

function pickAllowAlwaysId(params) {
  const options = listPermissionOptions(params);
  const always =
    options.find((option) => option.kind === "allow_always") ||
    options.find((option) => /allow_always|always allow|don't ask/.test(optionSignal(option)));
  return always ? always.optionId : pickAllowOnceId(params);
}

function permissionToolKind(params) {
  const p = params || {};
  const call = p.toolCall || p.tool_call || {};
  return String(call.kind || "").toLowerCase();
}

// The option JAgents picks by itself in this mode, or "" when the user decides.
function autoPermissionOption(mode, params) {
  const m = normalMode(mode);
  if (m === "full") return pickAllowAlwaysId(params);
  if (m === "auto") return pickAllowOnceId(params);
  if (m === "edits" && EDIT_KINDS.has(permissionToolKind(params))) return pickAllowOnceId(params);
  return "";
}

function acpPermissionResult(params, method) {
  const name = String(method || "");
  if (name.includes("write_text_file") || name.includes("read_text_file")) {
    return {};
  }
  const optionId = pickAllowOnceId(params);
  return { outcome: { outcome: "selected", optionId } };
}

module.exports = { PERMISSION_MODES, normalMode, listPermissionOptions, pickAllowOnceId, pickAllowAlwaysId, permissionToolKind, autoPermissionOption, acpPermissionResult };
