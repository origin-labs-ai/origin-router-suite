import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { DEFAULT_ROUTING_POLICY } from "@/lib/routingPolicy.js";

const DEFAULT_MITM_ROUTER_BASE = "http://localhost:20128";
const DEFAULT_HEADROOM_URL = process.env.HEADROOM_URL || "http://localhost:8787";

const DEFAULT_SETTINGS = {
  // Revolt Fusion extension-pack state: the setup tier the user picked, the
  // hand-picked feature categories (pro tier), and the installed pack registry.
  // `enabled: false` = the featherlight base — nothing extra is ever fetched.
  fusion: {
    enabled: false,
    tier: "daily", // daily | pro | monster
    features: [], // resolved category ids (see src/lib/fusion/catalog.js)
    packs: {}, // packId → { version, installedAt, features, dir }
    source: { kind: "github", repo: "origin-labs-ai/revolt-fusion" }, // or { kind: "local", dir }
  },
  cloudEnabled: false,
  tunnelEnabled: false,
  tunnelUrl: "",
  tunnelProvider: "cloudflare",
  tailscaleEnabled: false,
  tailscaleUrl: "",
  stickyRoundRobinLimit: 3,
  providerStrategies: {},
  quotaVisibility: {},
  comboStrategy: "fallback",
  comboStickyRoundRobinLimit: 1,
  comboStrategies: {},
  // false (default) = /v1 and /v1beta publish combo ids only. true = publish the
  // full provider/custom catalog as well. Provider models stay reachable either way.
  exposeAllModels: false,
  // Route combo traffic through /v1/origin, which accepts OpenAI, Anthropic and
  // Responses payloads and answers in the same shape the caller sent.
  originEndpointEnabled: true,
  capacityAdapter: {
    vision: { enabled: true, roundRobin: false, models: [] },
    pdf: { enabled: false, roundRobin: false, models: [] },
    audioInput: { enabled: true, roundRobin: false, models: [] },
    videoInput: { enabled: false, roundRobin: false, models: [] },
  },
  requireLogin: true,
  requireApiKey: true,
  tunnelDashboardAccess: true,
  authMode: "password",
  ssoType: "oidc",
  oidcIssuerUrl: "",
  oidcClientId: "",
  oidcClientSecret: "",
  oidcScopes: "openid profile email",
  oidcLoginLabel: "Sign in with OIDC",
  samlEntryPoint: "",
  samlIssuer: "urn:originrouter:sp",
  samlCert: "",
  samlLoginLabel: "Sign in with SAML SSO",
  samlAttributeEmail: "email",
  samlAttributeName: "name",
  enableObservability: false,
  observabilityMaxRecords: 1000,
  observabilityBatchSize: 20,
  observabilityFlushIntervalMs: 5000,
  observabilityMaxJsonSize: 5,
  outboundProxyEnabled: false,
  outboundProxyUrl: "",
  outboundNoProxy: "",
  mitmRouterBaseUrl: DEFAULT_MITM_ROUTER_BASE,
  dnsToolEnabled: {},
  rtkEnabled: true,
  headroomEnabled: false,
  headroomUrl: DEFAULT_HEADROOM_URL,
  headroomCompressUserMessages: false,
  headroomTimeoutMs: 3000,
  cavemanEnabled: false,
  cavemanLevel: "full",
  ponytailEnabled: false,
  ponytailLevel: "full",
  // User-authored system prompt, injected independently of the built-in savers.
  customPromptEnabled: false,
  customPrompt: "",
  pxpipeEnabled: false,
  pxpipeAutoInstall: true,
  pxpipeMinChars: 25000,
  pxpipeTimeoutMs: 15000,
  // Per-provider user header overrides applied at dispatch: { [providerId]: { headers: {..} } }
  providerOverrides: {},
  // Memory Fabric (src/lib/memoryFabric/): shared cross-agent context layer.
  // Ships OFF — injection only happens after an explicit opt-in, and every
  // consumer treats anything but `enabled === true` as disabled (fail-open).
  memoryFabric: { enabled: false },
  // Local Models page + its wizard step: whether the owner intends to download
  // local models at all, and where downloaded model files are saved. Empty dir
  // means the default <data>/models.
  localModels: { wantDownload: false, dir: "", defaultCtxSize: 4096, defaultPort: 8080, defaultGpuLayers: -1, binaryPath: "" },
  // Skills page catalog source (src/lib/skillsPipeline/). `kind` is the source
  // the page loads first (the UI toggle also remembers the user's last pick in
  // localStorage on top of this); `github` names the repo the cloud catalog is
  // fetched from — same shape as the payloads folder on disk (one dir per
  // skill, each with a SKILL.md), so both sources render through one card grid.
  skillsSource: {
    kind: "github", // github | local
    github: {
      owner: "origin-labs-ai",
      repo: "revolt-fusion",
      branch: "main",
      path: "skills",
    },
  },
  // The skills system prompt: the router tells every model what skills and
  // local models it can reach (open-sse/handlers/chatCore.js). The owner's
  // default is ON — the block is a menu of what exists, not an instruction.
  skills: { systemPrompt: { enabled: true } },
  // Routing resilience (see src/lib/routingPolicy.js). Concurrency is the
  // number of agent requests the router serves at once; the rest of the block
  // decides how long it keeps looking for a seat that answers, and the fact
  // that an upstream error is never handed to the client. Taken straight from the
  // policy module so the stored default and the runtime default cannot drift.
  routingPolicy: structuredClone(DEFAULT_ROUTING_POLICY),
};

async function readRaw() {
  const db = await getAdapter();
  const row = db.get(`SELECT data FROM settings WHERE id = 1`);
  return row ? parseJson(row.data, {}) : {};
}

// Merge raw settings with defaults; backward-compat for missing keys
export function mergeWithDefaults(raw) {
  const merged = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  for (const [key, defVal] of Object.entries(DEFAULT_SETTINGS)) {
    if (merged[key] === undefined) {
      if (
        key === "outboundProxyEnabled" &&
        typeof merged.outboundProxyUrl === "string" &&
        merged.outboundProxyUrl.trim()
      ) {
        merged[key] = true;
      } else {
        merged[key] = defVal;
      }
    }
  }
  if (merged.capacityAdapter && typeof merged.capacityAdapter === "object") {
    for (const capKey of Object.keys(merged.capacityAdapter)) {
      const entry = merged.capacityAdapter[capKey];
      if (Array.isArray(entry?.models)) {
        entry.models = entry.models.map((m) =>
          m === "oc/mimo-v2.5-free" ? "oc/mimo-v2.6-flash-free" : m
        );
      }
    }
  }
  // Routing policy is saved as one object, so a partial PATCH (a single knob)
  // must not erase the other keys.
  merged.routingPolicy = {
    ...DEFAULT_SETTINGS.routingPolicy,
    ...(merged.routingPolicy || {}),
    panda: {
      ...DEFAULT_SETTINGS.routingPolicy.panda,
      ...((merged.routingPolicy || {}).panda || {}),
    },
  };
  // Same nested-object rule for memoryFabric: a stored `{}` (older install or
  // partial write) must still resolve to the default `{ enabled: false }`.
  merged.memoryFabric = {
    ...DEFAULT_SETTINGS.memoryFabric,
    ...(merged.memoryFabric || {}),
  };
  // And for fusion: partial writes keep the tier but never lose the defaults.
  merged.fusion = {
    ...DEFAULT_SETTINGS.fusion,
    ...(merged.fusion || {}),
    ...(merged.fusion?.source ? { source: { ...DEFAULT_SETTINGS.fusion.source, ...merged.fusion.source } } : {}),
  };
  // Same nested rule for localModels: a partial PATCH never erases wantDownload
  // or dir, and an older install without the block gets the defaults.
  merged.localModels = {
    ...DEFAULT_SETTINGS.localModels,
    ...(merged.localModels || {}),
  };
  // And for skillsSource: the github repo block is nested one level deeper, so
  // a partial PATCH of just `kind` must not lose owner/repo/branch/path (and
  // vice versa) — same drill as fusion.source above.
  merged.skillsSource = {
    ...DEFAULT_SETTINGS.skillsSource,
    ...(merged.skillsSource || {}),
    github: {
      ...DEFAULT_SETTINGS.skillsSource.github,
      ...((merged.skillsSource || {}).github || {}),
    },
  };
  // Same nested rule for skills.systemPrompt: a partial PATCH must never lose
  // the enabled flag, and an older install without the block gets the default.
  merged.skills = {
    ...DEFAULT_SETTINGS.skills,
    ...(merged.skills || {}),
    systemPrompt: {
      ...DEFAULT_SETTINGS.skills.systemPrompt,
      ...((merged.skills || {}).systemPrompt || {}),
    },
  };
  return merged;
}

export async function getSettings() {
  const raw = await readRaw();
  return mergeWithDefaults(raw);
}

// Atomic read-merge-write inside transaction (prevents losing concurrent updates)
export async function updateSettings(updates) {
  const db = await getAdapter();
  let next;
  db.transaction(function () {
    const row = db.get(`SELECT data FROM settings WHERE id = 1`);
    const current = row ? parseJson(row.data, {}) : {};
    next = { ...current, ...updates };
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [stringifyJson(next)],
    );
  });
  return mergeWithDefaults(next);
}

export async function isCloudEnabled() {
  const settings = await getSettings();
  return settings.cloudEnabled === true;
}

export async function getCloudUrl() {
  const settings = await getSettings();
  return (
    settings.cloudUrl ||
    process.env.CLOUD_URL ||
    process.env.NEXT_PUBLIC_CLOUD_URL ||
    ""
  );
}

export async function exportSettings() {
  return await readRaw();
}
