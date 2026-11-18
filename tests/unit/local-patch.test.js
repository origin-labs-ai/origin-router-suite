import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// state.js resolves the data dir at import time, so the temp dir has to exist
// before the dynamic import below.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "or-patch-data-"));
process.env.DATA_DIR = dataDir;

const { fingerprintBundle, manifestFromBundle, isManifestCurrent, readPatchStatus, writePatchStatus, PATCH_DIR } =
  await import("../../src/lib/localPatch/state.mjs");
const { detectTargets, planPatch, buildNeedsRefresh } = await import("../../src/lib/localPatch/plan.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "or-patch-"));

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeBundle(dir, { buildId = "build-one", version = "0.7.0", serverMtime } = {}) {
  write(path.join(dir, ".next-cli-build", "BUILD_ID"), buildId);
  write(path.join(dir, "package.json"), JSON.stringify({ version }));
  write(path.join(dir, "server.js"), "// server\n");
  write(path.join(dir, "custom-server.js"), "// wrapper\n");
  if (serverMtime) fs.utimesSync(path.join(dir, "server.js"), serverMtime, serverMtime);
  return dir;
}

describe("local patch fingerprint", () => {
  it("reads the build id and version out of a bundle", () => {
    const bundle = makeBundle(path.join(tmp, "bundle-a"));
    const fingerprint = fingerprintBundle(bundle);
    expect(fingerprint.buildId).toBe("build-one");
    expect(fingerprint.version).toBe("0.7.0");
    expect(fingerprint.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes the hash when the build id changes", () => {
    const a = makeBundle(path.join(tmp, "bundle-b"), { buildId: "aaa" });
    const b = makeBundle(path.join(tmp, "bundle-c"), { buildId: "bbb" });
    expect(fingerprintBundle(a).hash).not.toBe(fingerprintBundle(b).hash);
  });

  it("treats a manifest as current only for the same bundle hash", () => {
    const bundle = makeBundle(path.join(tmp, "bundle-d"));
    const fingerprint = fingerprintBundle(bundle);
    const manifest = manifestFromBundle(bundle);
    expect(isManifestCurrent(manifest, fingerprint)).toBe(true);
    expect(isManifestCurrent(manifest, { ...fingerprint, hash: "different" })).toBe(false);
    expect(isManifestCurrent(null, fingerprint)).toBe(false);
  });
});

describe("local patch build freshness", () => {
  it("marks the bundle stale when a source file is newer than server.js", () => {
    const repo = path.join(tmp, "freshness");
    const bundle = makeBundle(path.join(repo, "cli", "app"), { serverMtime: new Date(Date.now() - 60_000) });
    write(path.join(repo, "src", "old.js"), "// old\n");
    fs.utimesSync(path.join(repo, "src", "old.js"), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));

    expect(buildNeedsRefresh({ repoDir: repo, bundleDir: bundle }).stale).toBe(false);

    write(path.join(repo, "src", "new.js"), "// new\n");
    const result = buildNeedsRefresh({ repoDir: repo, bundleDir: bundle });
    expect(result.stale).toBe(true);
    expect(result.reason).toContain("newer than the bundle");
  });

  it("is stale when the bundle has no server.js", () => {
    const result = buildNeedsRefresh({ repoDir: tmp, bundleDir: path.join(tmp, "missing") });
    expect(result.stale).toBe(true);
  });
});

describe("local patch targets", () => {
  it("only returns folders that look like a bundle", () => {
    const root = path.join(tmp, "install");
    const bundle = makeBundle(path.join(root, "app"));
    const empty = path.join(tmp, "not-a-bundle", "app");
    fs.mkdirSync(empty, { recursive: true });

    const targets = detectTargets({ explicitDir: root });
    expect(targets).toHaveLength(1);
    expect(targets[0].appDir).toBe(path.resolve(bundle));

    expect(detectTargets({ explicitDir: path.join(tmp, "not-a-bundle") })).toHaveLength(0);
  });

  it("reports installed vs pending targets against a bundle", () => {
    const source = makeBundle(path.join(tmp, "source-bundle"), { buildId: "want" });
    const installed = makeBundle(path.join(tmp, "installed", "app"), { buildId: "have" });

    const before = planPatch({ targets: detectTargets({ explicitDir: path.join(tmp, "installed") }), bundleDir: source });
    expect(before.targets[0].current).toBe(false);

    write(path.join(installed, ".patch.json"), JSON.stringify({ hash: fingerprintBundle(source).hash }));
    const after = planPatch({ targets: detectTargets({ explicitDir: path.join(tmp, "installed") }), bundleDir: source });
    expect(after.targets[0].current).toBe(true);
  });
});

describe("local patch status file", () => {
  it("merges phase updates instead of dropping earlier fields", () => {
    expect(PATCH_DIR).toBe(path.join(dataDir, "patch"));
    writePatchStatus({ phase: "requested", appDir: "C:/app" });
    writePatchStatus({ phase: "healthy", ok: true });
    const status = readPatchStatus();
    expect(status.phase).toBe("healthy");
    expect(status.appDir).toBe("C:/app");
    expect(status.ok).toBe(true);
  });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeAll(() => {
  expect(fs.existsSync(dataDir)).toBe(true);
});
