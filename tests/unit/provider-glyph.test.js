// Letter glyphs for icon-less (Hand Picked / compatible) providers.
import { describe, it, expect } from "vitest";
import { providerGlyph, providerAccentColor, splitNameSegments } from "../../src/shared/utils/providerGlyph.js";

describe("providerGlyph", () => {
  it("follows the owner's spec examples", () => {
    expect(providerGlyph("NexAPI")).toBe("N");
    expect(providerGlyph("OrcaRouter")).toBe("OR");
  });

  it("handles separators and case boundaries", () => {
    expect(providerGlyph("Orca-Router")).toBe("OR");
    expect(providerGlyph("Orca Route")).toBe("OR");
    expect(providerGlyph("ollama")).toBe("O");
    expect(providerGlyph("GLM")).toBe("G");
    expect(providerGlyph("Z.ai API")).toBe("Z");
    expect(providerGlyph("deepseek-web")).toBe("DW"); // two real words, like Orca-Router → OR
  });

  it("falls back to ? for empty names", () => {
    expect(providerGlyph("")).toBe("?");
    expect(providerGlyph(null)).toBe("?");
  });

  it("accent colors are deterministic and in-palette", () => {
    const c1 = providerAccentColor("openai-compatible-chat-abc");
    const c2 = providerAccentColor("openai-compatible-chat-abc");
    expect(c1).toBe(c2);
    expect(c1).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it("splitNameSegments splits camelCase and separators", () => {
    expect(splitNameSegments("OrcaRouter")).toEqual(["Orca", "Router"]);
    expect(splitNameSegments("NexAPI")).toEqual(["Nex", "API"]);
    expect(splitNameSegments("Orca Route")).toEqual(["Orca", "Route"]);
  });
});
