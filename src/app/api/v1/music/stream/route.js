import { handleMusicStream, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/music/stream - ElevenLabs music streaming */
export const POST = handleMusicStream;
