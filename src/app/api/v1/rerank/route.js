import { handleRerank, preflight } from "@/sse/handlers/derived/textIntelligence.js";
export const POST = handleRerank;
export const OPTIONS = preflight;
