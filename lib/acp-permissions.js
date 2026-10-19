// ACP permission answers, adapted from Cutline desktop. JAgents subagents
// work in the chosen workspace folder on the user's behalf, so ordinary tool calls are
// allowed once; file reads and writes go through the client fs handlers.

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

function acpPermissionResult(params, method) {
  const name = String(method || "");
  if (name.includes("write_text_file") || name.includes("read_text_file")) {
    return {};
  }
  const optionId = pickAllowOnceId(params);
  return { outcome: { outcome: "selected", optionId } };
}

module.exports = { listPermissionOptions, pickAllowOnceId, acpPermissionResult };
