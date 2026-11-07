// Skills pipeline tests — frontmatter parsing, CONFLICT.md merge policy,
// byte-exact dir-tree install with overwrite refusal, and scan purity
// (a scan must never write to the destination).
//
// Hermetic like fusion-loader.test.js: DATA_DIR is pointed at a temp dir
// BEFORE any src import, so run-level functions that persist lastRun hit a
// throwaway SQLite in the temp dir — the real ~/.or is never touched.
// Fixture skill dirs are created per-test in temp dirs; nothing in the repo
// tree is written.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

const TMP = mkdtempSync(join(tmpdir(), "or-skills-pipeline-"));
process.env.DATA_DIR = TMP;

const {
  parseSkillMd,
  scanSourceDir,
  mergeSkills,
  installSkills,
  runScan,
  runInstall,
  installOne,
} = await import("../../src/lib/skillsPipeline/index.js");

// ─── Fixture helpers ─────────────────────────────────────────────────────────

// Create one skill dir: SKILL.md from name/description (either may be omitted
// to exercise fallbacks) plus any extra sibling files/dirs via `files`.
function makeSkill(root, dirName, { name, description, body = "# Body\n\nSome markdown.", files = {} } = {}) {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  let md = "";
  if (name !== undefined || description !== undefined) {
    md += "---\n";
    if (name !== undefined) md += `name: ${name}\n`;
    if (description !== undefined) md += `description: ${description}\n`;
    md += "---\n";
  }
  md += body;
  writeFileSync(join(dir, "SKILL.md"), md);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

// Recursive snapshot of a tree: relative path → sha256 of bytes. Used for
// byte-exact install assertions and for proving scans write nothing.
function snapshot(root) {
  const out = {};
  const walk = (dir, rel) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const key = rel ? `${rel}/${dirent.name}` : dirent.name;
      const p = join(dir, dirent.name);
      if (dirent.isDirectory()) walk(p, key);
      else out[key] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  if (existsSync(root)) walk(root, "");
  return out;
}

const SRC = join(TMP, "source");
const DEST = join(TMP, "dest");

beforeAll(() => {
  // The fixture catalog: quoted/unquoted/missing fields, an internal
  // duplicate, nested sibling files, a dot-dir and ledger files that must
  // NOT be treated as skills.
  makeSkill(SRC, "alpha", {
    name: "alpha",
    description: "Quoted description",
    files: { "references/ref.md": "# ref", "scripts/run.sh": "echo hi\n" },
  });
  makeSkill(SRC, "beta", { name: '"beta"', description: "'single-quoted'" }); // quoted frontmatter
  makeSkill(SRC, "gamma", { description: "no name key — dirName fallback" }); // missing name
  makeSkill(SRC, "delta", { body: "no frontmatter at all" }); // no frontmatter
  makeSkill(SRC, "dup-a", { name: "dup", description: "first wins" });
  makeSkill(SRC, "dup-b", { name: "dup", description: "second — skipped" });
  mkdirSync(join(SRC, ".system", "imagegen"), { recursive: true });
  writeFileSync(join(SRC, ".system", "imagegen", "SKILL.md"), "---\nname: sys-imagegen\n---\n");
  writeFileSync(join(SRC, "ADDED-SKILLS.md"), "# ledger\n");
  writeFileSync(join(SRC, "flat-skill-SKILL.md"), "---\nname: flat\n---\n");
  mkdirSync(DEST, { recursive: true });
});

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

describe("parseSkillMd", () => {
  it("parses unquoted name and description and keeps the body", () => {
    const r = parseSkillMd("---\nname: alpha\ndescription: does things\n---\n\n# Body\ntext");
    expect(r.name).toBe("alpha");
    expect(r.description).toBe("does things");
    expect(r.body).toBe("\n# Body\ntext");
  });

  it("tolerates double and single quotes", () => {
    expect(parseSkillMd('---\nname: "quoted"\ndescription: \'single\'\n---\n').name).toBe("quoted");
    expect(parseSkillMd('---\nname: "quoted"\ndescription: \'single\'\n---\n').description).toBe("single");
  });

  it("returns empty description when the key is missing", () => {
    const r = parseSkillMd("---\nname: only-name\n---\nbody");
    expect(r.name).toBe("only-name");
    expect(r.description).toBe("");
  });

  it("ignores indented nested keys (metadata maps) and repeat keys", () => {
    const md = [
      "---",
      "name: real",
      "metadata:",
      "  name: fake-nested",
      "description: first",
      "description: second",
      "---",
      "",
    ].join("\n");
    const r = parseSkillMd(md);
    expect(r.name).toBe("real");
    expect(r.description).toBe("first");
  });

  it("treats missing or unterminated frontmatter as plain body (fail-open)", () => {
    expect(parseSkillMd("no frontmatter").name).toBe("");
    expect(parseSkillMd("no frontmatter").body).toBe("no frontmatter");
    const unterminated = parseSkillMd("---\nname: never closed");
    expect(unterminated.name).toBe("");
    expect(unterminated.body).toContain("never closed");
  });
});

// ─── Scanning ────────────────────────────────────────────────────────────────

describe("scanSourceDir", () => {
  it("returns one entry per dir containing SKILL.md, sorted by dirName", () => {
    const entries = scanSourceDir(SRC);
    const dirNames = entries.map((e) => e.dirName);
    // .system, the ledger and the flat -SKILL.md file are never entries.
    expect(dirNames).toEqual(["alpha", "beta", "delta", "dup-a", "dup-b", "gamma"]);
  });

  it("falls back to dirName when frontmatter lacks name, unquotes values", () => {
    const entries = scanSourceDir(SRC);
    const byDir = Object.fromEntries(entries.map((e) => [e.dirName, e]));
    expect(byDir.gamma.name).toBe("gamma"); // no name key → dirName
    expect(byDir.delta.name).toBe("delta"); // no frontmatter → dirName
    expect(byDir.beta.name).toBe("beta"); // quotes stripped
    expect(byDir.beta.description).toBe("single-quoted");
    expect(byDir.alpha.description).toBe("Quoted description");
    expect(byDir.alpha.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(byDir.alpha.path).toContain(join("alpha", "")); // absolute source path
  });

  it("is deterministic: same dir scanned twice gives identical output", () => {
    expect(scanSourceDir(SRC)).toEqual(scanSourceDir(SRC));
  });

  it("returns [] for a missing directory instead of throwing (fail-open)", () => {
    expect(scanSourceDir(join(TMP, "does-not-exist"))).toEqual([]);
  });
});

// ─── Merge policy (CONFLICT.md) ──────────────────────────────────────────────

describe("mergeSkills", () => {
  it("skips incoming skills whose name already exists (case-insensitive)", () => {
    const existing = [{ dirName: "ALPHA", name: "Alpha", description: "", path: "/x/ALPHA", sha256: "a" }];
    const incoming = scanSourceDir(SRC); // includes alpha
    const { toInstall, toSkip, conflicts } = mergeSkills(incoming, existing);
    expect(toInstall.map((s) => s.name)).not.toContain("alpha");
    const skippedAlpha = toSkip.find((s) => s.name === "alpha");
    expect(skippedAlpha).toBeTruthy();
    const conflict = conflicts.find((c) => c.incomingName === "alpha");
    // The record carries BOTH sides' names, per CONFLICT.md.
    expect(conflict.reason).toBe("existing-wins");
    expect(conflict.incomingName).toBe("alpha");
    expect(conflict.existingName).toBe("Alpha");
  });

  it("internal duplicates: first by dirName wins, later ones skipped and recorded", () => {
    const { toInstall, toSkip, conflicts } = mergeSkills(scanSourceDir(SRC), []);
    expect(toInstall.find((s) => s.name === "dup")?.dirName).toBe("dup-a");
    const loser = toSkip.find((s) => s.name === "dup" && s.dirName === "dup-b");
    expect(loser).toBeTruthy();
    const conflict = conflicts.find((c) => c.reason === "internal-duplicate");
    expect(conflict.incomingDirName).toBe("dup-b");
    expect(conflict.existingName).toBe("dup");
    expect(conflict.existingPath).toContain("dup-a");
  });

  it("keeps every non-conflicting skill in toInstall exactly once", () => {
    const { toInstall, toSkip, conflicts } = mergeSkills(scanSourceDir(SRC), []);
    const names = toInstall.map((s) => s.name).sort();
    // 6 dirs − 1 internal duplicate = 5 unique installs ("dup" once, from dup-a).
    expect(names).toEqual(["alpha", "beta", "delta", "dup", "gamma"]);
    expect(toSkip).toHaveLength(1); // only dup-b
    expect(conflicts).toHaveLength(1);
  });

  it("tolerates non-array input (fail-open)", () => {
    expect(mergeSkills(null, undefined)).toEqual({ toInstall: [], toSkip: [], conflicts: [] });
  });
});

// ─── Installing ──────────────────────────────────────────────────────────────

describe("installSkills", () => {
  it("copies the whole dir tree byte-exact (SKILL.md + siblings + nested dirs)", () => {
    const dest = join(TMP, "install-byte-exact");
    const entries = scanSourceDir(SRC).filter((s) => s.dirName === "alpha");
    const { installed, errors } = installSkills(entries, { destDir: dest });
    expect(errors).toEqual([]);
    expect(installed).toHaveLength(1);
    expect(installed[0].name).toBe("alpha");
    // Every file, byte-identical to its source (content hashes + tree shape).
    const srcSnap = snapshot(join(SRC, "alpha"));
    const dstSnap = snapshot(join(dest, "alpha"));
    expect(Object.keys(dstSnap).sort()).toEqual(Object.keys(srcSnap).sort());
    for (const [rel, hash] of Object.entries(srcSnap)) {
      expect(dstSnap[rel]).toBe(hash);
      expect(readFileSync(join(dest, "alpha", rel))).toEqual(readFileSync(join(SRC, "alpha", rel)));
    }
  });

  it("refuses to overwrite an existing dest dir (skip + record, dest untouched)", () => {
    const dest = join(TMP, "install-no-overwrite");
    const entries = scanSourceDir(SRC).filter((s) => s.dirName === "alpha");
    installSkills(entries, { destDir: dest });
    // Mutate the SOURCE after the first install: a second run must NOT copy it.
    writeFileSync(join(SRC, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: MUTATED\n---\n");
    const { installed, skipped } = installSkills(entries, { destDir: dest });
    expect(installed).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe("dest-exists");
    expect(readFileSync(join(dest, "alpha", "SKILL.md"), "utf8")).not.toContain("MUTATED");
    // Restore the fixture for later tests.
    writeFileSync(join(SRC, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: Quoted description\n---\n# Body\n\nSome markdown.");
  });

  it("records (never throws on) unsafe names and missing paths", () => {
    const dest = join(TMP, "install-errors");
    const bad = [
      // Both identity fields unsafe → nothing installable → recorded, not thrown.
      { name: "../escape", dirName: "..", path: join(SRC, "alpha"), sha256: "x" },
      { name: "no-path", dirName: "no-path", path: "", sha256: "x" },
    ];
    const { installed, errors } = installSkills(bad, { destDir: dest });
    expect(installed).toEqual([]);
    expect(errors).toHaveLength(2);
    expect(existsSync(join(dest, "escape"))).toBe(false);
  });
});

// ─── Run-level: scan purity + hermetic install ───────────────────────────────

describe("runScan / runInstall / installOne", () => {
  it("scan makes NO filesystem writes — dest is byte-identical after", async () => {
    // Pre-seed the dest so the merge has something to keep.
    makeSkill(DEST, "alpha", { name: "alpha", description: "already installed" });
    const before = snapshot(DEST);
    const report = await runScan({ sourceDir: SRC, destDir: DEST });
    expect(snapshot(DEST)).toEqual(before); // nothing added, nothing removed
    expect(report.discovered).toBe(6);
    expect(report.existing).toBe(1);
    expect(report.toInstallCount).toBe(4);
    expect(report.toSkipCount).toBe(2); // existing alpha + internal dup
    expect(report.conflicts.find((c) => c.reason === "existing-wins")).toBeTruthy();
  });

  it("install copies toInstall into dest and reports the run", async () => {
    const dest = join(TMP, "run-dest");
    const result = await runInstall({ sourceDir: SRC, destDir: dest });
    expect(result.install.errors).toEqual([]);
    expect(result.install.installed.map((s) => s.name).sort()).toEqual(["alpha", "beta", "delta", "dup", "gamma"]);
    expect(snapshot(join(dest, "alpha"))).toEqual(snapshot(join(SRC, "alpha")));
    expect(result.lastRun.installed).toBe(5);
    // Re-running is a no-op on disk: everything already exists, so the MERGE
    // (existing-wins, CONFLICT.md) skips all 5 and nothing is even copied.
    const second = await runInstall({ sourceDir: SRC, destDir: dest });
    expect(second.install.installed).toEqual([]);
    expect(second.install.skipped).toHaveLength(0);
    expect(second.toInstallCount).toBe(0);
    expect(second.toSkipCount).toBe(6); // 5 existing-wins (dup-a now matches installed "dup" too) + 1 internal duplicate
    expect(second.install.errors).toEqual([]);
  });

  it("install-one installs a single named skill and refuses conflicts", async () => {
    const dest = join(TMP, "one-dest");
    const ok = await installOne("beta", { sourceDir: SRC, destDir: dest });
    expect(ok.install.installed.map((s) => s.name)).toEqual(["beta"]);
    expect(existsSync(join(dest, "beta", "SKILL.md"))).toBe(true);
    // Existing wins → reported as a conflict skip, dest untouched.
    const clash = await installOne("beta", { sourceDir: SRC, destDir: dest });
    expect(clash.install.installed).toEqual([]);
    expect(clash.lastRun.reason).toBe("conflict");
    // Unknown name → not-found, not an error.
    const missing = await installOne("no-such-skill", { sourceDir: SRC, destDir: dest });
    expect(missing.lastRun.reason).toBe("not-found");
  });

  it("rejects a missing source dir before anything runs", async () => {
    await expect(runScan({ sourceDir: join(TMP, "missing-dir"), destDir: DEST })).rejects.toThrow(/not found/i);
    await expect(runInstall({ sourceDir: join(TMP, "missing-dir"), destDir: DEST })).rejects.toThrow(/not found/i);
  });
});
