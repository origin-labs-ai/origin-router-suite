// Skills catalog tests — the pure logic behind the redesigned Skills page:
//   - preview truncation (preview.js): frontmatter strip, whitespace collapse,
//     word-safe cut, "…" only when content was actually cut
//   - paging (catalog.pageSlice): full-list mode + 1-based server paging
//   - GitHub URL/source validation (githubSource): host allow-list, https,
//     port/credential refusals, segment charset — the SSRF guard, pinned
//   - github tree parsing + preview path policy, hermetically via a stubbed
//     global fetch (no network, no rate limits, deterministic)
//   - settings skillsSource nested merge (a partial PATCH must not lose the
//     repo block) and the local catalog/preview hermetically on temp dirs.
//
// Hermetic like skills-pipeline.test.js: DATA_DIR points at a temp dir BEFORE
// any src import; nothing in the repo tree is read or written.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "or-skills-catalog-"));
process.env.DATA_DIR = TMP;

const {
  skillPreview,
  previewWithEllipsis,
  skillCardText,
  skillDescription,
  wordSafeSlice,
  CARD_PREVIEW_CHARS,
  PREVIEW_MAX_CHARS,
} = await import("../../src/lib/skillsPipeline/preview.js");
const { pageSlice, localCatalog, localPreview } = await import("../../src/lib/skillsPipeline/catalog.js");
const { resolveSourceDir, defaultDestDir } = await import("../../src/lib/skillsPipeline/index.js");
const {
  assertGithubUrl,
  normalizeSkillsSource,
  listGithubSkills,
  fetchGithubPreview,
  fetchGithubSkillText,
  gitBlobSha,
  DEFAULT_SKILLS_SOURCE,
} = await import("../../src/lib/skillsPipeline/githubSource.js");
const { mergeWithDefaults } = await import("../../src/lib/db/repos/settingsRepo.js");

// ─── Preview truncation (preview.js) ─────────────────────────────────────────

describe("skillPreview", () => {
  it("strips frontmatter and collapses whitespace to one line-ish string", () => {
    const md = "---\nname: alpha\ndescription: meta, not prose\n---\n\n# Heading\n\n  Body   text\n\twith\ttabs.";
    const { preview, truncated } = skillPreview(md, 500);
    expect(preview).toBe("# Heading Body text with tabs.");
    expect(truncated).toBe(false);
  });

  it("treats missing/unterminated frontmatter as plain body (fail-open)", () => {
    expect(skillPreview("no frontmatter here", 100).preview).toBe("no frontmatter here");
    expect(skillPreview("---\nname: never closed", 100).preview).toContain("never closed");
  });

  it("appends no ellipsis when the text fits the limit", () => {
    expect(previewWithEllipsis("short body", 100)).toBe("short body");
  });

  it("truncates at a word boundary; previewWithEllipsis adds '…' only when cut", () => {
    const text = "first second third fourth fifth";
    const { preview, truncated } = skillPreview(text, 20);
    expect(truncated).toBe(true);
    // The raw cut stays on whole-word boundaries; the ellipsis is a display
    // concern added by previewWithEllipsis (both routes ship that form).
    expect(preview).toBe("first second third");
    expect(text.startsWith(preview)).toBe(true);
    expect(previewWithEllipsis(text, 20)).toBe("first second third…");
    expect(previewWithEllipsis("short body", 20)).toBe("short body"); // fits → no dots
  });

  it("does not collapse the preview to nothing for one very long token", () => {
    // A URL/hash longer than the limit must keep at least half the budget.
    const token = "x".repeat(300);
    const cut = wordSafeSlice(`${token} tail`, 50);
    expect(cut.length).toBeGreaterThanOrEqual(25);
  });

  it("clamps the limit to PREVIEW_MAX_CHARS (no whole-file pulls)", () => {
    const text = "word ".repeat(PREVIEW_MAX_CHARS); // ~6x the cap
    const { preview, truncated } = skillPreview(text, 999_999);
    expect(preview.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS);
    expect(truncated).toBe(true);
  });

  it("returns an empty preview for empty input without lying about truncation", () => {
    expect(skillPreview("", 100)).toEqual({ preview: "", truncated: false });
  });

  it("keeps the card default at 280 chars (the contract the page renders)", () => {
    expect(CARD_PREVIEW_CHARS).toBe(280);
  });
});

describe("skillCardText / skillDescription", () => {
  it("prefers the frontmatter description over the body opening", () => {
    const md = "---\nname: alpha\ndescription: A short description of the skill.\n---\n# Heading\n\nBody prose.";
    expect(skillDescription(md)).toBe("A short description of the skill.");
    expect(skillCardText(md, 280)).toBe("A short description of the skill.");
  });

  it("falls back to the body when there is no usable description", () => {
    const md = "---\nname: alpha\ndescription: >-\n---\n# Heading\n\nBody prose.";
    expect(skillDescription(md)).toBe(""); // block marker is not prose
    expect(skillCardText(md, 280)).toBe("# Heading Body prose.");
  });

  it("appends '…' only when the card text was actually cut", () => {
    const long = `---\nname: alpha\ndescription: ${"word ".repeat(200)}\n---\n`;
    expect(skillCardText(long, 40).endsWith("…")).toBe(true);
    expect(skillCardText("---\nname: alpha\n---\nshort body", 40)).toBe("short body");
  });
});

// ─── Paging (catalog.pageSlice) ──────────────────────────────────────────────

describe("pageSlice", () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ name: `s${i}` }));

  it("returns the FULL list when no page is given (the mode the page uses)", () => {
    const r = pageSlice(list, null, null);
    expect(r.skills).toEqual(list);
    expect(r.total).toBe(10);
    expect(r.page).toBeNull();
    expect(r.hasMore).toBe(false);
  });

  it("slices 1-based pages and reports hasMore", () => {
    const r = pageSlice(list, 2, 3);
    expect(r.skills.map((s) => s.name)).toEqual(["s3", "s4", "s5"]);
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(3);
    expect(r.hasMore).toBe(true);
  });

  it("last page: hasMore false; beyond-the-end page: empty slice", () => {
    expect(pageSlice(list, 4, 3).hasMore).toBe(false);
    expect(pageSlice(list, 4, 3).skills).toHaveLength(1);
    expect(pageSlice(list, 99, 3)).toMatchObject({ skills: [], hasMore: false, total: 10 });
  });

  it("caps pageSize at 200 and floors page at 1", () => {
    expect(pageSlice(list, 1, 9999).pageSize).toBe(200);
    expect(pageSlice(list, 0, 3).page).toBe(1);
    expect(pageSlice(list, "bogus", 3).page).toBe(1);
  });

  it("tolerates non-array input (fail-open)", () => {
    expect(pageSlice(undefined, 1, 3).skills).toEqual([]);
  });
});

// ─── GitHub URL + source validation (githubSource) ───────────────────────────

describe("assertGithubUrl", () => {
  it("allows the two GitHub hosts over https", () => {
    expect(assertGithubUrl("https://api.github.com/repos/o/r/git/trees/main")).toBeTruthy();
    expect(assertGithubUrl("https://raw.githubusercontent.com/o/r/main/skills/x/SKILL.md")).toBeTruthy();
  });

  it("refuses non-https, non-GitHub hosts, odd ports and embedded credentials", () => {
    expect(() => assertGithubUrl("http://api.github.com/x")).toThrow(/non-https/i);
    expect(() => assertGithubUrl("https://evil.example.com/x")).toThrow(/non-GitHub host/i);
    expect(() => assertGithubUrl("https://127.0.0.1/x")).toThrow(/non-GitHub host/i);
    expect(() => assertGithubUrl("file:///etc/passwd")).toThrow();
    expect(() => assertGithubUrl("https://api.github.com:8080/x")).toThrow(/port/i);
    expect(() => assertGithubUrl("https://user:pass@api.github.com/x")).toThrow(/credentials/i);
    expect(() => assertGithubUrl("not a url")).toThrow(/unparseable/i);
  });
});

describe("normalizeSkillsSource", () => {
  it("fills defaults and accepts the documented default shape", () => {
    expect(normalizeSkillsSource(undefined)).toEqual(DEFAULT_SKILLS_SOURCE);
    expect(normalizeSkillsSource({ repo: "other" })).toEqual({ ...DEFAULT_SKILLS_SOURCE, repo: "other" });
    // Multi-segment repo paths and slashes in path are legitimate.
    expect(normalizeSkillsSource({ path: "a/b/c" }).path).toBe("a/b/c");
  });

  it("refuses anything that could bend a URL (charset, traversal, edges)", () => {
    expect(() => normalizeSkillsSource({ owner: "evil.com/x" })).toThrow(/owner/); // no slashes in owner
    expect(() => normalizeSkillsSource({ owner: "o?q" })).toThrow(/owner/);
    expect(() => normalizeSkillsSource({ branch: "main?x=1" })).toThrow(/branch/);
    expect(() => normalizeSkillsSource({ branch: "a b" })).toThrow(/branch/); // no whitespace
    expect(() => normalizeSkillsSource({ path: "../escape" })).toThrow(/"\.\."/);
    expect(() => normalizeSkillsSource({ path: "a/../b" })).toThrow(/"\.\."/);
    expect(() => normalizeSkillsSource({ path: "/abs" })).toThrow(/leading\/trailing/);
    expect(() => normalizeSkillsSource({ path: "skills/" })).toThrow(/leading\/trailing/);
  });
});

// ─── Tree parsing + preview policy, hermetic (stubbed global fetch) ──────────

// Minimal Response stand-in for the fields fetchText touches.
function jsonResponse(body, { status = 200, ok = true, headers = {} } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Nope",
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}
function textResponse(text, { status = 200, ok = true } = {}) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Nope",
    headers: { get: () => null },
    text: async () => text,
  };
}

const FIXTURE_TREE = {
  // GitHub's subtree API returns paths RELATIVE to the requested folder
  // (main:payloads/skills), which is what listGithubSkills re-prefixes.
  tree: [
    { type: "tree", path: "alpha", sha: "t0" }, // tree nodes are ignored
    { type: "blob", path: "alpha/SKILL.md", sha: "a1" },
    { type: "blob", path: "alpha/references/ref.md", sha: "r1" }, // sibling — not a skill
    { type: "blob", path: "beta/SKILL.md", sha: "b2" },
    { type: "blob", path: "README.md", sha: "rd" }, // bare file — not a skill dir
    { type: "blob", path: "SKILL.md", sha: "x0" }, // bare SKILL.md — no dir, skipped
    { type: "blob", path: "nested/deep/SKILL.md", sha: "n1" }, // deeper nesting: parent dir wins
  ],
  truncated: false,
};

describe("listGithubSkills (stubbed fetch)", () => {
  afterAll(() => vi.unstubAllGlobals());

  it("derives one entry per SKILL.md dir under the path, sorted, with notes", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url, init) => {
      calls.push({ url: String(url), init });
      return jsonResponse(FIXTURE_TREE);
    });
    const { skills, truncated, notes } = await listGithubSkills({ source: { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-a" } });

    expect(skills.map((s) => s.dirName)).toEqual(["alpha", "beta", "deep"]);
    // path = the repo-relative SKILL.md BLOB path — exactly what
    // fetchGithubPreview (and so the client's preview fetches) hand back.
    expect(skills.find((s) => s.dirName === "deep")?.path).toBe("payloads/skills/nested/deep/SKILL.md");
    expect(skills.every((s) => s.sha && s.path.endsWith("/SKILL.md"))).toBe(true);
    expect(truncated).toBe(false);
    expect(notes).toEqual([]);
    // Exactly ONE api.github.com tree call, https, recursive, UA set, no token.
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("api.github.com");
    // Subtree request: branch:path — not the whole mono-repo tree.
    expect(decodeURIComponent(url.pathname)).toBe("/repos/origin-labs-ai/fixture-a/git/trees/main:payloads/skills");
    expect(url.searchParams.get("recursive")).toBe("1");
    expect(calls[0].init.headers["User-Agent"]).toContain("origin-router");
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });

  it("caches the tree for the TTL (second call = zero fetches)", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount += 1;
      return jsonResponse(FIXTURE_TREE);
    });
    await listGithubSkills({ source: { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-b" } });
    await listGithubSkills({ source: { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-b" } });
    expect(fetchCount).toBe(1);
  });

  it("surfaces a truncated tree as a note instead of silently showing a subset", async () => {
    vi.stubGlobal("fetch", async () => jsonResponse({ ...FIXTURE_TREE, truncated: true }));
    const { notes } = await listGithubSkills({ source: { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-c" } });
    expect(notes.some((n) => /truncated/i.test(n))).toBe(true);
  });

  it("throws on a GitHub error status so the caller can fall back to local", async () => {
    // Exhausted rate limit (403 + x-ratelimit-remaining: 0) gets the friendly
    // message that names the GITHUB_TOKEN fix.
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ message: "rate limited" }, { status: 403, ok: false, headers: { "x-ratelimit-remaining": "0" } }),
    );
    await expect(
      listGithubSkills({ source: { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-d" } }),
    ).rejects.toThrow(/rate limit/i);
  });

  it("retries the built-in catalog once on 404 and says so in notes", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      if (String(url).includes("revolt-fusion")) {
        return jsonResponse({ message: "Not Found" }, { status: 404, ok: false });
      }
      return jsonResponse(FIXTURE_TREE);
    });
    const { skills, notes, sourceConfig } = await listGithubSkills({
      source: { owner: "origin-labs-ai", repo: "revolt-fusion", branch: "main", path: "skills" },
    });
    expect(calls).toHaveLength(2); // stale source, then the built-in one
    expect(skills.length).toBe(3);
    expect(notes.some((n) => /not found \(404\)/i.test(n))).toBe(true);
    expect(sourceConfig).toEqual(DEFAULT_SKILLS_SOURCE); // previews follow the fallback
  });
});

describe("fetchGithubPreview (stubbed fetch)", () => {
  afterAll(() => vi.unstubAllGlobals());

  it("fetches the SKILL.md from raw.githubusercontent.com and previews it", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      return textResponse("---\nname: alpha\n---\nOpening body text that goes on for a while.".repeat(3));
    });
    const { preview, card, description, truncated } = await fetchGithubPreview(
      { source: { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-e" } },
      "payloads/skills/alpha/SKILL.md",
      500,
    );
    expect(preview).toContain("Opening body text");
    expect(preview.startsWith("name:")).toBe(false); // frontmatter stripped
    expect(card).toContain("Opening body text"); // no description → body
    expect(description).toBe("");
    expect(truncated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]).hostname).toBe("raw.githubusercontent.com");
  });

  it("refuses paths that are not a SKILL.md under the configured path — before any fetch", async () => {
    let fetchCount = 0;
    vi.stubGlobal("fetch", async () => {
      fetchCount += 1;
      return textResponse("nope");
    });
    const source = { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-f" };
    await expect(
      fetchGithubPreview({ source }, "payloads/skills/alpha/other.md", 100),
    ).rejects.toThrow(/SKILL\.md under/);
    await expect(fetchGithubPreview({ source }, "secrets/SKILL.md", 100)).rejects.toThrow(/SKILL\.md under/);
    await expect(fetchGithubPreview({ source }, "../etc/passwd", 100)).rejects.toThrow(/invalid/);
    expect(fetchCount).toBe(0); // validation is a hard gate, not a best effort
  });

  it("falls back to the jsDelivr mirror when raw.githubusercontent.com is unreachable", async () => {
    const calls = [];
    vi.stubGlobal("fetch", async (url) => {
      calls.push(String(url));
      if (String(url).includes("raw.githubusercontent.com")) {
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      }
      return textResponse("---\nname: alpha\n---\nMirror body text.");
    });
    const { preview } = await fetchGithubPreview(
      { source: { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-g" } },
      "payloads/skills/alpha/SKILL.md",
      100,
    );
    expect(preview).toContain("Mirror body text");
    expect(new URL(calls.at(-1)).hostname).toBe("cdn.jsdelivr.net");
    // One raw attempt, then the mirror — a connect timeout is not retried.
    expect(calls.length).toBe(2);
  });

  it("verifies an installed SKILL.md against the tree sha (mirror content is not trusted)", async () => {
    const text = "---\nname: alpha\n---\nbody";
    vi.stubGlobal("fetch", async () => textResponse(text));
    const source = { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-h" };
    const file = "payloads/skills/alpha/SKILL.md";

    expect(await fetchGithubSkillText({ source }, file, gitBlobSha(text))).toBe(text);
    await expect(fetchGithubSkillText({ source }, file, "deadbeef")).rejects.toThrow(/verification failed/i);
  });

  it("sends GITHUB_TOKEN to api.github.com only — never to raw or the CDN", async () => {
    process.env.GITHUB_TOKEN = "ghp_test_token_do_not_leak";
    const seen = [];
    vi.stubGlobal("fetch", async (url, init = {}) => {
      const host = new URL(String(url)).hostname;
      seen.push({ host, auth: init.headers?.Authorization });
      if (host === "api.github.com") {
        return jsonResponse({
          tree: [{ path: "alpha/SKILL.md", type: "blob", sha: gitBlobSha("---\nname: alpha\n---\nbody") }],
          truncated: false,
        });
      }
      return textResponse("---\nname: alpha\n---\nbody");
    });
    const source = { ...DEFAULT_SKILLS_SOURCE, repo: "fixture-i" };
    try {
      await listGithubSkills({ source });
      await fetchGithubSkillText({ source }, "payloads/skills/alpha/SKILL.md");
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
    expect(seen.find((c) => c.host === "api.github.com")?.auth).toBe("Bearer ghp_test_token_do_not_leak");
    // raw.githubusercontent.com and cdn.jsdelivr.net are third parties: a PAT
    // must never ride along to them.
    expect(seen.filter((c) => c.host !== "api.github.com").every((c) => !c.auth)).toBe(true);
  });
});

// ─── Settings merge (skillsSource nested block) ──────────────────────────────

describe("mergeWithDefaults: skillsSource", () => {
  it("defaults to the code mono-repo's payloads catalog", () => {
    const s = mergeWithDefaults({});
    expect(s.skillsSource).toEqual({
      kind: "github",
      github: { owner: "origin-labs-ai", repo: "code", branch: "main", path: "payloads/skills" },
    });
  });

  it("a partial PATCH of kind does not lose the repo block", () => {
    const s = mergeWithDefaults({ skillsSource: { kind: "local" } });
    expect(s.skillsSource.kind).toBe("local");
    expect(s.skillsSource.github).toEqual(DEFAULT_SKILLS_SOURCE);
  });

  it("a partial PATCH of one repo key does not lose the others (or kind)", () => {
    const s = mergeWithDefaults({ skillsSource: { github: { repo: "custom-repo" } } });
    expect(s.skillsSource.kind).toBe("github");
    expect(s.skillsSource.github.owner).toBe("origin-labs-ai");
    expect(s.skillsSource.github.repo).toBe("custom-repo");
    expect(s.skillsSource.github.branch).toBe("main");
  });

  it("migrates the dead 0.6 revolt-fusion catalog but keeps a custom repo", () => {
    const legacy = mergeWithDefaults({
      skillsSource: { github: { owner: "origin-labs-ai", repo: "revolt-fusion", branch: "main", path: "skills" } },
    });
    expect(legacy.skillsSource.github).toEqual(DEFAULT_SKILLS_SOURCE);

    const custom = mergeWithDefaults({
      skillsSource: { github: { owner: "someone", repo: "their-skills", branch: "dev", path: "catalog" } },
    });
    expect(custom.skillsSource.github).toEqual({
      owner: "someone",
      repo: "their-skills",
      branch: "dev",
      path: "catalog",
    });
  });
});

// ─── Local catalog + preview (hermetic temp dir) ─────────────────────────────

const LOCAL_SRC = join(TMP, "local-catalog");

function makeSkill(dirName, body) {
  const dir = join(LOCAL_SRC, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

describe("localCatalog / localPreview", () => {
  beforeAll(() => {
    makeSkill("alpha", "---\nname: Alpha Skill\ndescription: meta\n---\nAlpha body opening line.");
    makeSkill("beta", "Beta body without frontmatter.");
    writeFileSync(join(LOCAL_SRC, "loose-notes.md"), "not a skill dir");
  });
  afterAll(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("lists the same entry shape as github, previews included inline", async () => {
    const { skills, notes } = await localCatalog({ sourceDir: LOCAL_SRC });
    expect(skills.map((s) => s.dirName)).toEqual(["alpha", "beta"]);
    expect(skills[0].name).toBe("Alpha Skill"); // frontmatter name preferred
    expect(skills[0].preview).toContain("Alpha body opening line.");
    expect(skills[0].preview.startsWith("description:")).toBe(false);
    expect(skills[1].preview).toContain("Beta body");
    expect(notes).toEqual([]);
  });

  it("serves a longer preview by name and refuses unsafe names/paths", async () => {
    const ok = await localPreview({ sourceDir: LOCAL_SRC }, "alpha", 2000);
    expect(ok.preview).toContain("Alpha body opening line.");
    expect(ok.truncated).toBe(false);
    await expect(localPreview({ sourceDir: LOCAL_SRC }, "../escape", 100)).rejects.toThrow(/invalid skill name/);
    await expect(localPreview({ sourceDir: LOCAL_SRC }, "no-such-skill", 100)).rejects.toThrow(/no SKILL\.md/);
  });

  it("adds no machine-specific path note when the local catalog is empty", async () => {
    const { skills, notes } = await localCatalog({ sourceDir: join(TMP, "empty-catalog") });
    expect(skills).toEqual([]);
    // The page has its own empty state; the old note leaked an absolute path
    // from one developer's machine into every install's UI.
    expect(notes).toEqual([]);
  });

  it("defaults an unconfigured local source to this app's installed skills", async () => {
    expect(await resolveSourceDir()).toBe(await defaultDestDir());
    expect(await resolveSourceDir()).not.toMatch(/code-fusion/);
  });
});
