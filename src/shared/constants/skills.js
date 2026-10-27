// Agent Skills metadata — single source of truth for /dashboard/skills page.
// Each skill = 1 raw GitHub URL the user copies and pastes to any AI agent.

const REPO = "decolua/originrouter";
const BRANCH = "master";
const SKILL_PATH = "skills";

export const SKILLS_REPO_URL = `https://github.com/${REPO}`;
export const SKILLS_RAW_BASE = `https://raw.githubusercontent.com/${REPO}/refs/heads/${BRANCH}/${SKILL_PATH}`;
export const SKILLS_BLOB_BASE = `https://github.com/${REPO}/blob/${BRANCH}/${SKILL_PATH}`;

export const SKILLS = [
  {
    id: "originrouter",
    name: "OriginRouter (Entry)",
    description: "Setup + index of all capabilities. Start here — covers base URL, auth, model discovery, and links to every capability skill.",
    endpoint: null,
    icon: "hub",
    isEntry: true,
  },
  {
    id: "originrouter-chat",
    name: "Chat",
    description: "Chat / code-gen via OpenAI or Anthropic format with streaming.",
    endpoint: "/v1/chat/completions",
    icon: "chat",
  },
  {
    id: "originrouter-image",
    name: "Image Generation",
    description: "Text-to-image via DALL-E, Imagen, FLUX, MiniMax, SDWebUI…",
    endpoint: "/v1/images/generations",
    icon: "image",
  },
  {
    id: "originrouter-tts",
    name: "Text-to-Speech",
    description: "OpenAI / ElevenLabs / Edge / Google / Deepgram voices.",
    endpoint: "/v1/audio/speech",
    icon: "record_voice_over",
  },
  {
    id: "originrouter-stt",
    name: "Speech-to-Text",
    description: "Transcribe audio via OpenAI Whisper, Groq, Gemini, Deepgram, AssemblyAI…",
    endpoint: "/v1/audio/transcriptions",
    icon: "mic",
  },
  {
    id: "originrouter-embeddings",
    name: "Embeddings",
    description: "Vectors for RAG / semantic search via OpenAI, Gemini, Mistral…",
    endpoint: "/v1/embeddings",
    icon: "scatter_plot",
  },
  {
    id: "originrouter-web-search",
    name: "Web Search",
    description: "Web and X search via Tavily / Exa / Brave / Serper / SearXNG / Google PSE / You.com / Xquik.",
    endpoint: "/v1/search",
    icon: "search",
  },
  {
    id: "originrouter-web-fetch",
    name: "Web Fetch",
    description: "URL → markdown / text / HTML via Firecrawl, Jina, Tavily, Exa.",
    endpoint: "/v1/web/fetch",
    icon: "language",
  },
];

export function getSkillRawUrl(id) {
  return `${SKILLS_RAW_BASE}/${id}/SKILL.md`;
}

export function getSkillBlobUrl(id) {
  return `${SKILLS_BLOB_BASE}/${id}/SKILL.md`;
}
