import { handleImageUpscale, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/images/upscale - image-to-image super resolution */
export const POST = handleImageUpscale;
