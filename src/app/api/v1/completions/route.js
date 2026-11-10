import { handleCompletions, preflight } from "@/sse/handlers/derived/textIntelligence.js";
export const POST = handleCompletions;
export const OPTIONS = preflight;
