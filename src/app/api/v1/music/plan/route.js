import { handleMusicPlan, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/music/plan - ElevenLabs composition plan */
export const POST = handleMusicPlan;
