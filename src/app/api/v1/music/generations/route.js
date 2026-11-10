import { handleMusicGenerations, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/music/generations - OpenAI-style music generation */
export const POST = handleMusicGenerations;
