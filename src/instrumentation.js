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

    // Headroom auto-start: when the owner has Token Saver compression enabled,
    // the proxy comes back with the gateway — it must never read "Stopped"
    // after every reboot just because nobody clicked Start again. Fail-open:
    // any problem leaves the page's own Start button in charge.
    try {
      const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
      const settings = await getSettings();
      if (settings?.headroomEnabled) {
        const { probeProxyRunning } = await import("@/lib/headroom/detect.js");
        const url = settings.headroomUrl || "http://localhost:8787";
        const alreadyUp = await probeProxyRunning(url);
        if (!alreadyUp) {
          const { startHeadroomProxy } = await import("@/lib/headroom/process.js");
          const started = await startHeadroomProxy({
            codeAware: settings.headroomCodeAware === true,
            kompress: settings.headroomKompress !== false,
          });
          console.log(`[headroom] auto-start at ${url} → pid ${started?.pid ?? "?"}${started?.alreadyRunning ? " (already running)" : ""}`);
        }
      }
    } catch (error) {
      console.log("[headroom] auto-start skipped:", error?.message || error);
    }
  }
}
