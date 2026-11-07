/**
 * The Cloudflare Workers deployment this suite used to cover is NOT part of
 * this repository: there is no `cloud/` directory (see CLAUDE.md — "the
 * `cloud/` worker dir is not in this repo"), so `cloud/src/handlers/embeddings.js`
 * cannot be imported and the suite failed to load.
 *
 * The behaviour it guarded lives in the Next.js app now:
 *   - `src/app/api/v1/embeddings/route.js`  (the HTTP surface)
 *   - `src/sse/handlers/embeddings.js`      (the handler)
 *   - `open-sse/handlers/embeddingsCore.js`  (the core logic)
 *
 * The file is kept (as a skipped placeholder) so the suite still loads and the
 * removal stays visible in the test list instead of silently disappearing.
 * Drop the guard back in here when the worker is vendored again.
 */
import { describe, it, expect } from "vitest";

describe("cloud embeddings handler (worker not vendored in this repo)", () => {
  it.skip("cloud/src/handlers/embeddings.js is not part of this repository", () => {
    expect(true).toBe(true);
  });
});
