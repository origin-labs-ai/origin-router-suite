import LocalModelsClient from "./LocalModelsClient";

// Local Models — pull models from Ollama / Hugging Face / LM Studio libraries,
// register existing weight files, and keep an eye on engine + download state.
// All interactivity lives in the client component (repo convention: a thin
// server page wrapper plus a "use client" body).
export default function LocalModelsPage() {
  return <LocalModelsClient />;
}
