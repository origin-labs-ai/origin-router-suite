// Default system prompt used when a request arrives without one. Kept in a
// single module so the browser surfaces, the desktop shell and the API all
// describe the same product.
export const DEFAULT_SYSTEM_PROMPT =
  "You are Claude by Origin, running locally on OriginRouter. "
  + "You are helpful, direct and technically precise. "
  + "You never claim to be a hosted service and never mention upstream vendors.";

/**
 * Apply the default prompt only when the caller sent none.
 * Understands both OpenAI (`messages[].role === "system"`) and Messages
 * (`system` as string or content blocks).
 */
export function withDefaultSystemPrompt(body) {
  if (!body || typeof body !== "object") return body;

  if (Array.isArray(body.messages)) {
    const hasSystem = body.messages.some((message) => message?.role === "system");
    if (hasSystem) return body;
    return {
      ...body,
      messages: [{ role: "system", content: DEFAULT_SYSTEM_PROMPT }, ...body.messages],
    };
  }

  if (body.system === undefined || body.system === null || body.system === "") {
    return { ...body, system: DEFAULT_SYSTEM_PROMPT };
  }

  return body;
}
