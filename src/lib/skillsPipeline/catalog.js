// Catalog glue for the Skills page: one entry shape, two sources.
//
// The page renders a card grid; the grid does not care where a skill came
// from, so both sources normalize to the same entry:
//   { dirName, name, description, path, preview, sha? }
//   - dirName  the on-disk/repo directory name (stable identity)
//   - name     display name (frontmatter name when the local scan has it)
//   - path     github: repo-relative SKILL.md BLOB path (what the preview
//              endpoint fetches via raw.githubusercontent.com); local:
//              ABSOLUTE dir path (display only — local previews key on the
//              validated dir name instead, never on a client-supplied path)
//   - preview  display-ready opening text of SKILL.md, "…" already appended
//              when truncated (see preview.js — never authored, always quoted)
//
// Failure policy: github problems are captured, never thrown to the route —
// the route falls back to the local catalog and carries the note to the UI.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { scanSourceDir, resolveSourceDir } from "./index.js";
import { CARD_PREVIEW_CHARS, PREVIEW_MAX_CHARS, previewWithEllipsis, skillPreview } from "./preview.js";
import { fetchGithubPreview, listGithubSkills } from "./githubSource.js";

export { CARD_PREVIEW_CHARS, PREVIEW_MAX_CHARS };

// Safe single path segment (same rule index.js applies to install dest names).
// Settings and query params are untrusted; this keeps a `name` from ever
// walking out of the catalog dir.
function isSafeSegment(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && name !== "..";
}

// Clamp a caller-supplied preview limit: default card length, hard cap so no
// request can pull a whole SKILL.md (or repo file) through the preview surface.
export function clampPreviewLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return CARD_PREVIEW_CHARS;
  return Math.min(Math.floor(n), PREVIEW_MAX_CHARS);
}

// ─── Local source ────────────────────────────────────────────────────────────

// Read one skill's SKILL.md from the local catalog dir and preview it.
// `name` must be a safe segment — the dir is resolved and pinned inside the
// catalog root before anything is read (defense in depth on top of the regex).
export async function localPreview(opts, name, limit) {
  const root = resolve(String(opts?.sourceDir || (await resolveSourceDir())));
  if (!isSafeSegment(name)) throw new Error(`invalid skill name: ${JSON.stringify(String(name))}`);
  // join() with a validated single segment cannot escape, and the resolved
  // prefix check pins it anyway (belt and braces — resolve() normalizes
  // separators on both sides, so the comparison is exact on every OS).
  const dir = resolve(join(root, name));
  if (dir !== root && !dir.startsWith(root + sep)) {
    throw new Error("skill path escapes the catalog dir");
  }
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) throw new Error(`no SKILL.md for skill: ${name}`);
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`could not read SKILL.md for ${name}: ${err?.message || err}`);
  }
  const { preview, truncated } = skillPreview(text, limit);
  return { name, path: join(dir, "SKILL.md"), preview, truncated };
}

// The full local catalog: same scanner the pipeline uses (dirs with a
// SKILL.md, sorted by dirName), plus a preview per entry. Local reads are
// cheap (no rate limits), so the list response carries previews inline —
// the page renders cards without a second round of fetches.
export async function localCatalog(opts = {}) {
  const sourceDir = resolve(
    String(opts.sourceDir || "").trim() || (await resolveSourceDir()),
  );
  const entries = scanSourceDir(sourceDir);
  const notes = [];
  if (!entries.length) {
    notes.push(`Local catalog is empty or unreadable: ${sourceDir}`);
  }
  const skills = entries.map((entry) => {
    let preview = "";
    if (entry.path) {
      try {
        preview = previewWithEllipsis(readFileSync(join(entry.path, "SKILL.md"), "utf8"), CARD_PREVIEW_CHARS);
      } catch {
        // Unreadable SKILL.md → empty preview, the card still shows the name.
      }
    }
    return {
      dirName: entry.dirName,
      name: entry.name,
      description: entry.description || "",
      path: entry.path,
      preview,
    };
  });
  return { skills, notes, sourceDir };
}

// ─── GitHub source ───────────────────────────────────────────────────────────

// The github list is one tree API call (cached 10 min in githubSource) — fast
// enough to return the WHOLE catalog and let the page render incrementally.
// Previews are NOT fetched here: that would be one raw.githubusercontent.com
// request per skill (950+) on every cold page load. Cards fetch their preview
// from /api/skills-pipeline/preview as they mount, which is also cheaper —
// the user only ever previews what they actually scroll to.
export async function githubCatalog(opts = {}) {
  const { skills, truncated, notes } = await listGithubSkills(opts);
  const allNotes = [...notes];
  if (!skills.length) allNotes.push("No skill folders with a SKILL.md found in the repo tree.");
  return {
    skills: skills.map((s) => ({
      dirName: s.dirName,
      name: s.name,
      description: "",
      path: s.path,
      preview: "", // filled on demand by the preview endpoint
      sha: s.sha,
    })),
    notes: allNotes,
    truncated: !!truncated,
  };
}

// One github preview (cached per file in githubSource).
export async function githubPreview(opts, filePath, limit) {
  return fetchGithubPreview(opts, filePath, limit);
}

// ─── Paging ──────────────────────────────────────────────────────────────────

// Server-side slice over the catalog. The page itself loads the FULL list and
// renders incrementally (one API call, instant filtering) — page/pageSize
// exist for callers that want true server paging, and the route comment
// documents both modes. 1-based page; pageSize defaults to 50, hard-capped so
// a huge pageSize cannot balloon the response.
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export function pageSlice(skills, page, pageSize) {
  const list = Array.isArray(skills) ? skills : [];
  const hasPaging = page !== undefined && page !== null && String(page).trim() !== "";
  if (!hasPaging) {
    // No paging requested → full list (the mode the page uses).
    return { skills: list, total: list.length, page: null, pageSize: null, hasMore: false };
  }
  const size = Math.max(1, Math.min(Number(pageSize) || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE));
  const num = Math.max(1, Math.floor(Number(page) || 1));
  const start = (num - 1) * size;
  const slice = list.slice(start, start + size);
  return {
    skills: slice,
    total: list.length,
    page: num,
    pageSize: size,
    hasMore: start + size < list.length,
  };
}
