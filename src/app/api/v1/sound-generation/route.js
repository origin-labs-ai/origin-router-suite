import { handleSoundGeneration, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/sound-generation - ElevenLabs sound effects */
export const POST = handleSoundGeneration;
