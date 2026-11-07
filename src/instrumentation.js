export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();

    // Server-only: lets capabilities.js read the synced catalog without pulling
    // node:fs into the dashboard's browser bundle.
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();

    // Owner-declared context ceilings (~/.or/context-ceilings.json) become the
    // capability table's ceiling source for the whole server, so no consumer —
    // provider rows, pickers, the playground filter, /v1/models — can present the
    // 200K runtime floor as if it were a model's limit. Registered here rather than
    // per route because every route is its own bundle and would need the import
    // repeated; loading the module installs the source, the call primes the cache.
    const { applyContextCeilings } = await import("@/lib/contextCeilings.js");
    applyContextCeilings();

    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();

    // Discarded-feature revival: report a local PandaOrchestrator install at
    // boot (detection only — the router never spawns third-party binaries).
    const { reportPandaStatusAtBoot } = await import("@/lib/panda/spawn.js");
    await reportPandaStatusAtBoot();

    // OriginFold disk persistence: folds survive a gateway restart. Best-effort
    // — without the store, folds live in memory only (fail-open either way).
    const { installFoldStore } = await import("@/lib/foldStore.js");
    await installFoldStore();
  }
}
