import { handleMusicDetailedStream, preflight } from "@/sse/handlers/mediaAliases.js";

export const maxDuration = 300;
export const OPTIONS = preflight;
/** POST /v1/music/detailed/stream - ElevenLabs SSE metadata + audio chunks */
export const POST = handleMusicDetailedStream;
