// RevoltFusion loader — pack install/verify/activate tests.
// Uses a temp DATA_DIR so the real ~/.or is never touched.
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const TMP = mkdtempSync(join(tmpdir(), "or-fusion-test-"));
process.env.DATA_DIR = TMP;

const { resolveFeatures, CATEGORIES } = await import("../../src/lib/fusion/catalog.js");
const loader = await import("../../src/lib/fusion/loader.js");
const { createHash: _ch } = await import("node:crypto");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function makeFixturePack(dir, { packId = "revolt-fusion", version = "0.1.0", features = ["guardrails"], body = "export default { id: 'revolt-fusion' };" } = {}) {
  mkdirSync(dir, { recursive: true });
  const bodyBuf = Buffer.from(body);
  const manifest = {
    packId,
    version,
    features,
    files: { "index.js": sha256(bodyBuf) },
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, "index.js"), bodyBuf);
  return manifest;
}

describe("fusion catalog", () => {
  it("resolves the daily tier to nothing extra", () => {
    expect(resolveFeatures("daily")).toEqual([]);
  });

  it("resolves the monster tier to every category", () => {
    expect(resolveFeatures("monster")).toEqual(CATEGORIES.map((c) => c.id));
  });

  it("resolves pro defaults and validates hand-picks", () => {
    expect(resolveFeatures("pro")).toEqual(CATEGORIES.filter((c) => c.defaultOn).map((c) => c.id));
    expect(resolveFeatures("pro", ["guardrails", "bogus-category"])).toEqual(["guardrails"]);
    expect(resolveFeatures("pro", "not-an-array")).toEqual([]);
  });
});

describe("fusion loader", () => {
  it("installs from a local source and verifies hashes", async () => {
    const src = join(TMP, "src-pack");
    makeFixturePack(src);
    const res = await loader.installPack({ features: ["guardrails"], source: { kind: "local", dir: src } });
    expect(res.ok).toBe(true);
    expect(res.packId).toBe("revolt-fusion");
  });

  it("refuses a tampered pack (hash mismatch)", async () => {
    const src = join(TMP, "src-pack-tampered");
    makeFixturePack(src, { packId: "revolt-fusion", version: "0.1.1" });
    writeFileSync(join(src, "index.js"), "export default { hacked: true };");
    await expect(loader.installPack({ features: [], source: { kind: "local", dir: src } })).rejects.toThrow(/hash mismatch/);
  });

  it("refuses a manifest with a path-traversal packId", async () => {
    const src = join(TTMP_SAFE());
    mkdirSync(src, { recursive: true });
    const bodyBuf = Buffer.from("export default {};");
    writeFileSync(join(src, "manifest.json"), JSON.stringify({
      packId: "../evil",
      version: "1.0.0",
      features: ["guardrails"],
      files: { "index.js": sha256(bodyBuf) },
    }));
    writeFileSync(join(src, "index.js"), bodyBuf);
    await expect(loader.installPack({ features: [], source: { kind: "local", dir: src } })).rejects.toThrow(/packId invalid/);
  });

  it("loads and activates the installed pack module", async () => {
    const src = join(TMP, "src-pack-load");
    makeFixturePack(src, { version: "0.2.0", body: "export default { id: 'revolt-fusion', hello: () => 'world' };" });
    await loader.installPack({ features: ["guardrails"], source: { kind: "local", dir: src } });
    const mod = await loader.loadPackModule("revolt-fusion");
    expect(mod.hello()).toBe("world");
  });

  it("refuses a GitHub source on a non-allowlisted host by construction", async () => {
    const loader2 = await import("../../src/lib/fusion/loader.js");
    // The URL guard is internal; exercise it through a wrong-host rejection.
    await expect(loader2.installPack({ features: [], source: { kind: "github", repo: "ok/repo", tag: "v1", host: "http://127.0.0.1" } })).rejects.toThrow();
  });
});

function TTMP_SAFE() {
  return join(TMP, "src-pack-evil");
}
