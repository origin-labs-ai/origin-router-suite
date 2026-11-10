import { handleFileUpload, handleFileList, preflight } from "@/sse/handlers/files.js";

export const maxDuration = 300;
export const OPTIONS = preflight;
/** POST /v1/files - upload a file; GET /v1/files - list files */
export const POST = handleFileUpload;
export const GET = handleFileList;
