// Generate the static provider catalog consumed by the GitHub Pages onboarding app.
// The registry is the single source of truth; this snapshot keeps the browser
// bundle free of Node builtins and prevents provider keys from ever entering a build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import REGISTRY from "../open-sse/providers/registry/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.resolve(here, "../site/providers.json");

const supportsApiKey = (entry) =>
  entry.category === "apikey" ||
  entry.authModes?.includes("apikey") ||
  entry.oauth?.authModes?.includes("apikey");

const kinds = new Set(["chat", "embedding", "tts", "stt", "image", "video", "music", "search"]);
const all = REGISTRY.flat();
const providers = all
  .filter(supportsApiKey)
  .map((entry) => {
    const models = entry.models || [];
    const mediaKinds = [];
    for (const kind of kinds) {
      const flag = {
        tts: entry.ttsConfig,
        stt: entry.sttConfig,
        embedding: entry.embeddingConfig,
        image: entry.imageConfig,
        video: entry.videoConfig,
        music: entry.musicConfig,
        search: entry.searchConfig || entry.searchViaChat,
      }[kind];
      if (flag || models.some((m) => m.kind === kind)) mediaKinds.push(kind);
    }
    return {
      id: entry.id,
      alias: entry.alias || entry.id,
      name: entry.display?.name || entry.id,
      icon: entry.display?.icon || "api",
      color: entry.display?.color || "#6366f1",
      textIcon: entry.display?.textIcon || "",
      website: entry.display?.website || "",
      apiKeyUrl: entry.display?.notice?.apiKeyUrl || "",
      category: entry.category || "apikey",
      modelCount: models.length,
      sampleModels: models.slice(0, 6).map((m) => m.name || m.id),
      media: mediaKinds,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const payload = {
  generatedAt: new Date().toISOString(),
  source: "open-sse/providers/registry/index.js",
  total: providers.length,
  providers,
};

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Wrote ${providers.length} API-key providers to ${path.relative(process.cwd(), outFile)}`);
