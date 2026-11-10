import { handleAudioTranslation, preflight } from "@/sse/handlers/mediaAliases.js";

export const maxDuration = 300;
export const OPTIONS = preflight;
/** POST /v1/audio/translations - Whisper-style audio translation */
export const POST = handleAudioTranslation;
