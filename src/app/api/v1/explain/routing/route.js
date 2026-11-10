import { handleExplainRouting, handleRoutingStrategies, preflight } from "@/sse/handlers/ops.js";

export const OPTIONS = preflight;
/** GET /v1/explain/routing - strategy registry; POST - explain a routing plan */
export const GET = handleRoutingStrategies;
export const POST = handleExplainRouting;
