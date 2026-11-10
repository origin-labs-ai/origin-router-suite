import { handleModelsQuery, preflight } from "@/sse/handlers/derived/textIntelligence.js";
export const POST = handleModelsQuery;
export const OPTIONS = preflight;
