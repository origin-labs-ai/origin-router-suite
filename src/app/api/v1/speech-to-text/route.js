import { handleSpeechToTextAlias, preflight } from "@/sse/handlers/mediaAliases.js";

export const maxDuration = 300;
export const OPTIONS = preflight;
/** POST /v1/speech-to-text - alias for /v1/audio/transcriptions */
export const POST = handleSpeechToTextAlias;
