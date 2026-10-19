function encodeFrame(obj) {
  const json = JSON.stringify(obj);
  const payload = Buffer.from(json, "utf8");
  return Buffer.concat([Buffer.from("Content-Length: " + payload.length + "\r\n\r\n", "utf8"), payload]);
}

function encodeNdjson(obj) {
  return Buffer.from(JSON.stringify(obj) + "\n", "utf8");
}

const MAX_FRAME_BUFFER = 8 * 1024 * 1024;

function createFrameParser(onMessage) {
  let buffer = Buffer.alloc(0);
  function push(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_FRAME_BUFFER) {
      // Drop only the oversized partial line and keep complete queued
      // frames; wiping everything orphans the requests those frames answer,
      // which reads as a generic ACP timeout minutes later. Fall through to
      // the extraction loop so queued frames still parse.
      const nl = buffer.indexOf(10);
      buffer = nl < 0 ? Buffer.alloc(0) : buffer.slice(nl + 1);
    }
    while (buffer.length) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd >= 0) {
        const header = buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          buffer = buffer.slice(headerEnd + 4);
          continue;
        }
        const length = Number(match[1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        const body = buffer.slice(start, start + length).toString("utf8");
        buffer = buffer.slice(start + length);
        try {
          onMessage(JSON.parse(body));
        } catch {
          /* ignore malformed */
        }
        continue;
      }
      const nl = buffer.indexOf(10);
      if (nl < 0) return;
      const line = buffer.slice(0, nl).toString("utf8").trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* ignore */
      }
    }
  }
  return { push };
}

module.exports = { encodeFrame, encodeNdjson, createFrameParser };
