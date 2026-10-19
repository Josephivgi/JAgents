const INITIALIZE_MS = 120_000;
const PROMPT_MS = 180_000;
const MODE_MS = 8_000;
const AUTH_MS = 600_000;
const DEFAULT_MS = 180_000;
// PROMPT_MS and PROMPT_GRACE_MS together are how long a prompt may go with
// no sign of life from the agent before it is asked to stop. They measure
// silence, not turn length: an agent that keeps streaming never hits them.
const PROMPT_GRACE_MS = 120_000;
// Silence allowed while a tool call or terminal command is still open (a
// long render or ffmpeg run streams nothing until it ends).
const TOOL_IDLE_MS = 30 * 60_000;
// After asking a wedged turn to stop, give the agent this long to answer
// with stopReason "cancelled" before the session is torn down.
const CANCEL_GRACE_MS = 10_000;

function requestTimeoutFor(method) {
  const name = String(method || "");
  if (name === "authenticate") return AUTH_MS;
  if (name === "session/set_mode" || name === "session/set_model" || name === "session/set_config_option" || name === "session/cancel") return MODE_MS;
  if (name === "initialize" || name === "session/new" || name === "session/load") return INITIALIZE_MS;
  if (name === "session/prompt") return PROMPT_MS;
  return DEFAULT_MS;
}

module.exports = {
  INITIALIZE_MS,
  PROMPT_MS,
  MODE_MS,
  DEFAULT_MS,
  PROMPT_GRACE_MS,
  CANCEL_GRACE_MS,
  TOOL_IDLE_MS,
  requestTimeoutFor,
};
