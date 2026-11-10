import { handleChat } from "./chat.js";

// WebSocket surface: a client connects to /v1/ws and sends chat bodies over the
// socket instead of HTTP. The message body is the same JSON /v1/chat/completions
// accepts; streaming responses are forwarded as raw SSE frames, non-streaming
// responses as one JSON object. The upgrade itself is wired in custom-server.js
// because Next's app router cannot own the socket.

const MAX_BUFFERED = 16 * 1024 * 1024; // 16MB — bounded, fail-open per connection

function safeSend(ws, payload) {
  try {
    if (ws.readyState === 1 && ws.bufferedAmount < MAX_BUFFERED) ws.send(payload);
  } catch {
    /* the peer may have dropped; nothing to recover */
  }
}

/**
 * Bind a connected socket to the chat pipeline.
 * @param {import("ws").WebSocket} ws
 * @param {{ url: string, headers?: object }} req
 */
export function handleWsChat(ws, req) {
  const baseUrl = req?.url || "/v1/ws";
  ws.on("message", async (raw) => {
    let body;
    try {
      body = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, JSON.stringify({ error: { message: "Invalid JSON message", type: "invalid_request_error" } }));
      return;
    }

    try {
      const request = new Request(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(req?.headers?.["authorization"] ? { authorization: req.headers["authorization"] } : {}),
        },
        body: JSON.stringify({ ...body, stream: body?.stream ?? true }),
      });
      const response = await handleChat(request);
      if (!response.ok) {
        safeSend(ws, JSON.stringify({
          error: {
            message: response.statusText || "Request failed",
            status: response.status,
            type: "server_error",
          },
        }));
        return;
      }
      const contentType = response.headers.get("content-type") || "";
      if (response.body && contentType.includes("text/event-stream")) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          safeSend(ws, decoder.decode(value, { stream: true }));
        }
        safeSend(ws, JSON.stringify({ type: "done" }));
      } else {
        const text = await response.text();
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        safeSend(ws, JSON.stringify({ type: "result", data: parsed }));
      }
    } catch (error) {
      safeSend(ws, JSON.stringify({ error: { message: error?.message || "Request failed", type: "server_error" } }));
    }
  });
}
