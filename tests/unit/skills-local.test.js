// Skills page "Local" catalog: what is really installed/imported/found on this
// machine. These tests use throwaway dirs only — no machine's ~/.or is touched.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "or-skills-local-"));
process.env.DATA_DIR = TMP;

const { discoverLocalSkills, importSkillFile } = await import(
  "../../src/lib/skillsPipeline/localSkills.js"
);

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

function makeSkill(dir, name, description = "A local skill.") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody text.\n`,
    "utf8",
  );
}

describe("discoverLocalSkills", () => {
  it("collects installed and home skills, but only real SKILL.md files", async () => {
    const installed = join(TMP, "installed");
    const home = join(TMP, "home");
    makeSkill(join(installed, "installed-one"), "installed-one");
    makeSkill(join(home, ".claude", "skills", "found-one"), "found-one");
    // A directory that looks like a skill but has no SKILL.md is not a card.
    mkdirSync(join(home, "projects", "not-a-skill"), { recursive: true });
    writeFileSync(join(home, "projects", "not-a-skill", "README.md"), "nope");

    const { skills, installedDir, notes } = await discoverLocalSkills({ installedDir: installed, home });
    expect(installedDir).toBe(installed);
    expect(skills.map((s) => s.dirName).sort()).toEqual(["found-one", "installed-one"]);
    const found = skills.find((s) => s.dirName === "found-one");
    expect(found.source).toBe("discovered");
    expect(found.path).toBe(join(home, ".claude", "skills", "found-one", "SKILL.md"));
    expect(found.description).toBe("A local skill.");
    expect(found.modalText).toContain("Body text");
    expect(notes).toEqual([]);
  });

  it("prefers an installed copy over a duplicate found elsewhere", async () => {
    const installed = join(TMP, "installed2");
    const home = join(TMP, "home2");
    makeSkill(join(installed, "shared"), "shared", "installed copy");
    makeSkill(join(home, "shared"), "shared", "home copy");
    const { skills } = await discoverLocalSkills({ installedDir: installed, home });
    expect(skills).toHaveLength(1);
    expect(skills[0].description).toBe("installed copy");
    expect(skills[0].source).toBe("installed");
  });
});

describe("importSkillFile", () => {
  it("writes the file under the installed dir and never overwrites a name", async () => {
    const root = join(TMP, "imports");
    const md = "---\nname: my-import\ndescription: Imported from disk\n---\n\nHi.\n";
    const first = await importSkillFile({ fileName: "picked.md", content: md, destDir: root });
    expect(first.dirName).toBe("my-import");
    expect(first.source).toBe("imported");
    expect(readFileSync(first.path, "utf8")).toBe(md);
    expect(existsSync(join(root, "my-import", "originrouter-import.json"))).toBe(true);

    const second = await importSkillFile({ fileName: "picked.md", content: md, destDir: root });
    expect(second.dirName).toBe("my-import-2");
    expect(readFileSync(join(root, "my-import", "SKILL.md"), "utf8")).toBe(md);
  });

  it("rejects empty files and hostile names", async () => {
    const root = join(TMP, "imports");
    await expect(importSkillFile({ content: "  ", destDir: root })).rejects.toThrow(/empty/i);
    const hostile = await importSkillFile({
      fileName: "../../evil.md",
      content: "just text, no frontmatter",
      destDir: root,
    });
    // A hostile fileName cannot dictate a path: it falls back to a safe name.
    expect(hostile.dirName).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(hostile.path.startsWith(root)).toBe(true);
  });
});
