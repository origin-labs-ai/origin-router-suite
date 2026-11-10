import { handleAgents, preflight } from "@/sse/handlers/ops.js";

export const OPTIONS = preflight;
/** GET /v1/agents - list agents; POST - create an agent */
export const GET = handleAgents;
export const POST = handleAgents;
