import { handleImageEdit, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/images/edits - OpenAI-style image edit/inpaint */
export const POST = handleImageEdit;
