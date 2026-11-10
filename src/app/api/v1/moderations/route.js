import { handleModerations, preflight } from "@/sse/handlers/derived/textIntelligence.js";
export const POST = handleModerations;
export const OPTIONS = preflight;
