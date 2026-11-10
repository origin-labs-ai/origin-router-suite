import { handleMusicDetailed, preflight } from "@/sse/handlers/mediaAliases.js";

export const maxDuration = 300;
export const OPTIONS = preflight;
/** POST /v1/music/detailed - ElevenLabs multipart audio + composition plan */
export const POST = handleMusicDetailed;
