import { handleCombos, preflight } from "@/sse/handlers/ops.js";

export const OPTIONS = preflight;
/** GET /v1/combos - list combos; POST - create a combo */
export const GET = handleCombos;
export const POST = handleCombos;
