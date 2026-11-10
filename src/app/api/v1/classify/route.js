import { handleClassify, preflight } from "@/sse/handlers/derived/textIntelligence.js";
export const POST = handleClassify;
export const OPTIONS = preflight;
