// Xiaomi ended the free MiMo channel ("MiMo free API service has ended").
// Kept visible per the owner's rule that nothing in the registry stays hidden:
// the card explains itself, and this enables the day a replacement channel is
// announced without a second edit here. The OAuth MiMo Platform is a separate
// entry ("mimo").
export default {
  id: "mimo-free",
  priority: 50,
  hasFree: true,
  alias: "mmf",
  uiAlias: "mmf",
  display: {
    name: "MiMo Code Free",
    icon: "smart_toy",
    color: "#FF6900",
    textIcon: "MF",
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "https://api.xiaomimimo.com/api/free-ai/openai/chat",
    noAuth: true,
  },
  models: [
    { id: "mimo-auto", name: "MiMo Auto" },
  ],
  modelsFetcher: { url: "https://models.dev/api.json", type: "mimo-free" },
  passthroughModels: true,
};
