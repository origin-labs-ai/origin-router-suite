import { handleTextToSpeechAlias, preflight } from "@/sse/handlers/mediaAliases.js";

export const OPTIONS = preflight;
/** POST /v1/text-to-speech/{voiceId} - alias for /v1/audio/speech */
export async function POST(request, { params }) {
  const { voiceId } = await params;
  return handleTextToSpeechAlias(request, voiceId);
}
