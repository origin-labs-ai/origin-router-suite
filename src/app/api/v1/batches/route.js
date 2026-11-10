import { handleBatchCreate, handleBatchList, preflight } from "@/sse/handlers/batches.js";

export const maxDuration = 300;
export const OPTIONS = preflight;
/** POST /v1/batches - create a batch; GET /v1/batches - list batches */
export const POST = handleBatchCreate;
export const GET = handleBatchList;
