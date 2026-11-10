import { handleMusic, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/music - ElevenLabs music composition (native audio) */
export const POST = handleMusic;
