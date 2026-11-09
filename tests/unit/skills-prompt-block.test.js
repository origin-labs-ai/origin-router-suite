// Skills prompt block — the router's menu of what it can reach, injected into
// the system prompt of every request (bridges included). Tests pin the pure
// builder and the injection mechanism chatCore uses (open-sse systemInject).
import { describe, expect, it } from "vitest";
import { buildSkillsPromptBlock } from "../../src/lib/skillsPipeline/promptBlock.js";
import { injectSystemPrompt } from "../../open-sse/rtk/systemInject.js";

describe("skills prompt block builder", () => {
  it("names skills and local models, capped, with a total-count note", () => {
    const skills = Array.from({ length: 45 }, (_, i) => ({ name: `skill-${i}`, description: `desc ${i}` }));
    const block = buildSkillsPromptBlock({ skills, models: [{ name: "qwen-0.5b", path: "C:/m/qwen.gguf" }] });
    expect(block).toContain("OriginRouter skills available");
    // Each line leads with the invocable command — that is what a model has to
    // emit to reach the skill, so it must be in the menu.
    expect(block).toContain("- /skill-0 — desc 0");
    expect(block).toContain("- /skill-39 — desc 39");
    expect(block).not.toContain("- /skill-40");
    expect(block).toContain("… and 5 more skills installed.");
    expect(block).toContain("Local models registered on this machine");
    expect(block).toContain("- qwen-0.5b (GGUF)");
  });

  it("empty inputs produce an empty string (nothing to inject)", () => {
    expect(buildSkillsPromptBlock({})).toBe("");
    expect(buildSkillsPromptBlock({ skills: [], models: [] })).toBe("");
    // Junk rows are dropped, never rendered as "- —"
    expect(buildSkillsPromptBlock({ skills: [{ name: "" }, null], models: [null] })).toBe("");
  });

  it("a skill without a description still names the skill", () => {
    const block = buildSkillsPromptBlock({ skills: [{ name: "solo" }] });
    expect(block).toContain("- /solo");
  });

  it("a description that is only a YAML block marker is treated as empty", () => {
    // parseSkillMd used to hand back the literal ">-" for folded descriptions;
    // that marker must never reach the model as if it were prose.
    const block = buildSkillsPromptBlock({ skills: [{ name: "canvas", description: ">-" }] });
    expect(block).toContain("- /canvas");
    expect(block).not.toContain(">-");
  });

  it("caps a long description so forty skills cannot eat the prompt", () => {
    const block = buildSkillsPromptBlock({ skills: [{ name: "long", description: "x".repeat(400) }] });
    const line = block.split("\n").find((row) => row.startsWith("- /long"));
    expect(line).toBeTruthy();
    expect(line.length).toBeLessThan(200);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("skills prompt injection (the chatCore mechanism)", () => {
  const BLOCK = "OriginRouter skills available (ask the router's skills API for the full index):\n- pdf — read PDFs";

  it("appends the block into an OpenAI-format system message", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectSystemPrompt(body, "openai", BLOCK);
    const rendered = JSON.stringify(body);
    expect(rendered).toContain("OriginRouter skills available");
    expect(rendered).toContain("- pdf — read PDFs");
  });

  it("is idempotent — the same block never lands twice", () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    injectSystemPrompt(body, "openai", BLOCK);
    const once = JSON.stringify(body);
    injectSystemPrompt(body, "openai", BLOCK);
    expect(JSON.stringify(body)).toBe(once);
  });

  it("survives a claude-format body (the bridge path)", () => {
    const body = { system: "You are helpful.", messages: [{ role: "user", content: "hi" }] };
    injectSystemPrompt(body, "claude", BLOCK);
    expect(JSON.stringify(body.system)).toContain("OriginRouter skills available");
  });
});
