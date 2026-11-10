import { handleSegment, preflight } from "@/sse/handlers/derived/textIntelligence.js";
export const POST = handleSegment;
export const OPTIONS = preflight;
