import { POST as chatPOST } from "@/app/api/v1/chat/completions/route";
import { POST as messagesPOST } from "@/app/api/v1/messages/route";
import { POST as responsesPOST } from "@/app/api/v1/responses/route";

// Origin-compatible endpoint: one URL that speaks every wire format. The body
// shape decides the target handler, and that handler already emits the matching
// response shape, so a client can point at /v1/origin no matter which SDK it uses.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function pickTarget(body) {
  if (!body || typeof body !== "object") return "chat";
  // Anthropic Messages: top-level `system` and/or `anthropic_version`, content
  // blocks instead of a Responses-style `input`.
  if (body.anthropic_version || typeof body.system === "string" || Array.isArray(body.system)) {
    return "messages";
  }
  // OpenAI Responses API carries `input` and no `messages`.
  if (body.input !== undefined && body.messages === undefined) {
    return "responses";
  }
  return "chat";
}

const HANDLERS = {
  chat: { handler: chatPOST, path: "/api/v1/chat/completions" },
  messages: { handler: messagesPOST, path: "/api/v1/messages" },
  responses: { handler: responsesPOST, path: "/api/v1/responses" },
};

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

export async function POST(request) {
  const raw = await request.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  }

  const { handler, path } = HANDLERS[pickTarget(body)];
  const url = new URL(request.url);
  url.pathname = path;

  const forwarded = new Request(url, {
    method: "POST",
    headers: request.headers,
    body: raw,
  });
  return handler(forwarded);
}
