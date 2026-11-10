import { handleOcr, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/ocr - document/image OCR over the vision chat pipeline */
export const POST = handleOcr;
