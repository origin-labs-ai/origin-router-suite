import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import codex from "../../open-sse/providers/registry/codex.js";
const root = new URL("../../", import.meta.url);
it("documents OAuth reuse, ffmpeg limits and does not offer unsupported response formats", () => {
  expect(codex.display.kindNotice.stt).toContain("ffmpeg");
  // The STT panel lives on the provider detail page now; the standalone
  // /dashboard/media-providers/<kind>/<id> route was folded into it.
  const page = readFileSync(new URL("src/app/(dashboard)/dashboard/providers/[id]/page.js", root), "utf8");
  expect(page).toContain("mediaKinds");
  expect(page).toContain("<SttExampleCard");
  const example = readFileSync(new URL("src/app/(dashboard)/dashboard/providers/[id]/components/SttExampleCard.js", root), "utf8");
  expect(example).toContain('selectedModelObj?.responseFormats');
  expect(readFileSync(new URL("Dockerfile", root), "utf8").split("AS runner")[1]).toContain("su-exec ffmpeg");
});
