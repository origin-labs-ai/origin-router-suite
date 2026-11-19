// The Skills page's "Local" catalog: skills that actually exist on THIS
// machine. GitHub is a browse/install source; Local is the truth about what a
// tool can invoke right now. Three ways a skill gets here:
//
//   1. installed  — put in <DATA_DIR>/skills by the GitHub installer,
//   2. imported   — a SKILL.md the user picked in the dashboard,
//   3. discovered — a SKILL.md already on disk under the home folder (other
//                   coding agents keep them in ~/.claude, ~/.codex, …).
//
// Reads are bounded (depth, directory budget, file size, result cap) so a
// random home folder full of caches never stalls the page. Everything is
// fail-open: an unreadable directory contributes nothing and the rest still
// loads. SKILL.md is DATA — parsed for display, never executed or imported.

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { defaultDestDir, parseSkillMd } from "./index.js";
import {
  CARD_PREVIEW_CHARS,
  PREVIEW_MAX_CHARS,
  skillCardText,
  skillDescription,
  skillPreview,
} from "./preview.js";

// Directories that are never worth walking: dependency trees, build output,
// OS caches and version-control internals. Skipping them keeps a "search the
// whole home folder" scan short and avoids reading secrets by accident.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".next-cli-build", "dist", "build", "out", "coverage",
  "AppData", "Library", "Caches", "Cache", "Temp", "tmp", ".cache", ".npm", ".venv", "venv",
  "__pycache__", ".gradle", ".cargo", ".rustup", ".local/share/Trash",
]);

// Agent tools keep their skills in dot folders. Those few are worth walking;
// every other dot folder stays private (caches, configs, secrets).
const ALLOW_DOT_DIRS = new Set([".claude", ".codex", ".gemini", ".cursor", ".continue", ".factory"]);

const MAX_DEPTH = 5; // home → tool dir → skills → skill dir → SKILL.md
const MAX_DIRS = 12000; // hard budget for directories visited in one scan
const MAX_SKILLS = 500; // cards in the grid; more is not useful in a dashboard
const MAX_FILE_BYTES = 1_048_576; // 1 MiB — a skill file is text, not a corpus
const IMPORT_MARKER = "originrouter-import.json";

// Same segment rule the installer uses. A user-chosen file name never becomes
// a path without passing this first.
function safeSegment(name) {
  const value = String(name ?? "");
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && value !== ".." ? value : "";
}

function inside(root, dir) {
  const r = resolve(root);
  const d = resolve(dir);
  return d === r || d.startsWith(r + sep);
}

function entryFromFile(file, source) {
  let text = "";
  try {
    const buf = readFileSync(file);
    if (buf.length > MAX_FILE_BYTES) return null;
    text = buf.toString("utf8");
  } catch {
    return null; // unreadable file is not a usable skill
  }
  const dir = dirname(file);
  const dirName = basename(dir) || "skill";
  const parsed = parseSkillMd(text);
  const previewResult = skillPreview(text, CARD_PREVIEW_CHARS);
  const preview = previewResult.truncated ? `${previewResult.preview}…` : previewResult.preview;
  const modalResult = skillPreview(text, PREVIEW_MAX_CHARS);
  const modalText = modalResult.truncated ? `${modalResult.preview}…` : modalResult.preview;
  let kind = source;
  if (source !== "imported" && existsSync(join(dir, IMPORT_MARKER))) kind = "imported";
  return {
    dirName,
    name: parsed.name || dirName,
    description: skillDescription(text),
    path: file,
    dir,
    preview,
    card: skillCardText(text, CARD_PREVIEW_CHARS),
    modalText,
    source: kind,
  };
}

// Walk one root, collecting directories with a SKILL.md. Symlinks are skipped
// (no escapes into other volumes), as are dot dirs and the skip list above.
function walk(root, source, out, seenFiles, budget, depth = 0) {
  if (depth > MAX_DEPTH || !root || budget.visited >= MAX_DIRS || out.length >= MAX_SKILLS) return;
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  budget.visited += 1;
  for (const dirent of dirents) {
    if (out.length >= MAX_SKILLS || budget.visited >= MAX_DIRS) break;
    if (!dirent.isDirectory()) continue; // never follow symlinks
    const name = dirent.name;
    if (SKIP_DIRS.has(name) || (name.startsWith(".") && !ALLOW_DOT_DIRS.has(name))) continue;
    const dir = join(root, name);
    const file = join(dir, "SKILL.md");
    if (existsSync(file)) {
      const real = resolve(file);
      if (!seenFiles.has(real)) {
        const entry = entryFromFile(file, source);
        if (entry) {
          seenFiles.add(real);
          out.push(entry);
        }
      }
      continue; // a skill dir is a leaf; its children are not scanned
    }
    if (depth < MAX_DEPTH) walk(dir, source, out, seenFiles, budget, depth + 1);
  }
}

/**
 * Discover every local SKILL.md this machine exposes to the page.
 *
 * @returns {Promise<{skills:Array, installedDir:string, notes:string[], truncated:boolean}>}
 */
export async function discoverLocalSkills(opts = {}) {
  const installedDir = resolve(String(opts.installedDir || "").trim() || (await defaultDestDir()));
  const home = resolve(String(opts.home || "").trim() || homedir());
  const seenFiles = new Set();
  const budget = { visited: 0 };
  const out = [];

  // Installed skills first so they win a name collision against a stray copy
  // somewhere else in the home folder.
  walk(installedDir, "installed", out, seenFiles, budget, 0);
  if (resolve(home) !== installedDir) walk(home, "discovered", out, seenFiles, budget, 0);

  // One card per name: the first copy (installed, then home order) wins.
  const seenNames = new Set();
  const skills = [];
  for (const entry of out) {
    const key = entry.dirName.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    skills.push(entry);
  }
  skills.sort((a, b) => {
    const rank = { imported: 0, installed: 1, discovered: 2 };
    return (rank[a.source] ?? 3) - (rank[b.source] ?? 3) || a.dirName.localeCompare(b.dirName);
  });

  const notes = [];
  if (budget.visited >= MAX_DIRS || out.length >= MAX_SKILLS) {
    notes.push(`Showing the first ${MAX_SKILLS} local skills found on this machine.`);
  }
  return { skills, installedDir, notes, truncated: out.length >= MAX_SKILLS };
}

/**
 * Import one user-picked SKILL.md into the installed-skills directory.
 * The browser sends the file's TEXT, never a path: the server decides the
 * destination from a sanitized frontmatter name (or the file's base name),
 * so a crafted file name cannot write outside the catalog.
 *
 * @returns {Promise<object>} the entry the Local grid should show
 */
export async function importSkillFile({ fileName = "", content = "", destDir = "" } = {}) {
  const text = typeof content === "string" ? content : "";
  if (!text.trim()) throw new Error("The selected SKILL.md is empty.");
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) throw new Error("SKILL.md is too large (1 MiB limit).");

  const parsed = parseSkillMd(text);
  const fromFrontmatter = safeSegment(parsed.name);
  const fromFile = safeSegment(basename(String(fileName)).replace(/\.md$/i, ""));
  const base = fromFrontmatter || fromFile || "imported-skill";
  const root = resolve(String(destDir || "").trim() || (await defaultDestDir()));

  // Existing wins: a name already installed is never overwritten. Suffix the
  // new copy instead so a re-import never destroys a working skill.
  let dirName = base;
  for (let n = 2; existsSync(join(root, dirName, "SKILL.md")); n += 1) {
    dirName = `${base}-${n}`;
    if (n > 50) throw new Error("Too many skills with that name.");
  }
  const dir = resolve(join(root, dirName));
  if (!inside(root, dir)) throw new Error("Skill path escapes the catalog dir.");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text, "utf8");
  writeFileSync(
    join(dir, IMPORT_MARKER),
    `${JSON.stringify({ fileName: String(fileName), importedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  const entry = entryFromFile(join(dir, "SKILL.md"), "imported");
  if (!entry) throw new Error("Imported SKILL.md could not be read back.");
  return entry;
}
