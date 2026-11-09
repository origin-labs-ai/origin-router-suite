// Skills pipeline — imports the owner's skills catalog from the code-fusion
// payloads directory into this app's skills storage, with duplicate-merging.
//
// SOURCE (the contract): C:\Users\thaku\Workspaces\fusion\code-fusion\payloads\skills
//   Each skill is ONE directory containing a SKILL.md whose YAML-ish frontmatter
//   (--- name: ... description: ... ---) is the entire contract (see that dir's
//   README.md / ADDED-SKILLS.md). Sibling files (references/, scripts/, …) are
//   part of the skill and must survive the copy byte-exact. payloads/CONFLICT.md
//   documents the merge policy this module implements:
//     - A pre-existing entry wins; the incoming same-name skill is skipped.
//     - Same-name duplicates within the source itself: the first one
//       (deterministic dirName order) wins, the rest are skipped.
//
// HOUSE RULES (repo conventions):
//   - Plain JS ESM, heavy comments, no TypeScript, no YAML dependency (the
//     frontmatter is parsed by hand — skills are DATA, and the two keys we need
//     do not justify a parser dependency).
//   - Fail-open: a malformed skill dir is recorded and skipped, never thrown
//     out of the whole run. One bad skill must not block 950 good ones.
//   - Skills are DATA — markdown + frontmatter only. NOTHING here executes,
//     evaluates or imports any skill content. We hash bytes and copy bytes.
//   - No shell, no child processes: all I/O goes through node:fs.
//   - Parameterized SQL where SQL exists (none here — see settingsRepo for the
//     settings row this module persists its lastRun into; it is parameterized).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  cpSync,
  statSync,
} from "node:fs";
import { join, resolve, sep, basename } from "node:path";

// ─── Paths ───────────────────────────────────────────────────────────────────

// Default import source: the code-fusion payloads skills catalog. Owner machines
// keep it at the fusion workspace checkout; the settings key
// `skillsPipeline.sourceDir` (see DEFAULT_SETTINGS use in the API route) can
// point this at any other catalog directory with the same shape.
export const DEFAULT_SOURCE_DIR =
  "C:\\Users\\thaku\\Workspaces\\fusion\\code-fusion\\payloads\\skills";

// Where installed skills live in THIS app. The existing skills system is the
// agent-skills directory convention (one dir per skill, each with a SKILL.md —
// the same shape src/shared/constants/skills.js publishes and the repo's own
// .agents/skills/<name>/SKILL.md uses), rooted at the runtime data dir so the
// install follows DATA_DIR like every other piece of app state and never
// writes into the source tree at runtime.
export async function defaultDestDir() {
  const { DATA_DIR } = await import("@/lib/dataDir.js");
  return join(DATA_DIR, "skills");
}

// Resolve the configured source dir: settings key skillsPipeline.sourceDir,
// else the payloads default above. Fail-open — any settings problem falls
// back to the default rather than breaking the pipeline.
export async function resolveSourceDir() {
  try {
    const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    const configured = settings?.skillsPipeline?.sourceDir;
    if (typeof configured === "string" && configured.trim()) return configured.trim();
  } catch {
    // settings unavailable (tests, first boot) — the default is still valid.
  }
  return DEFAULT_SOURCE_DIR;
}

// ─── Frontmatter parsing ─────────────────────────────────────────────────────

// Strip one layer of matching quotes (single or double) plus surrounding
// whitespace. Frontmatter values in the wild arrive as `name: foo`,
// `name: "foo"` and `name: 'foo'` — all mean the same plain string.
function unquote(value) {
  const v = String(value ?? "").trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1).trim();
    }
  }
  return v;
}

/**
 * Parse a SKILL.md into { name, description, body }.
 *
 * YAML-ish, by hand, no YAML dependency: the contract only needs the two
 * top-level scalar keys `name` and `description` from the leading `---` block.
 * Rules:
 *   - The frontmatter is the first `---` line through the next lone `---` line.
 *     No leading `---` at all → no frontmatter (fail-open: body is the whole
 *     text, name/description come back empty and callers fall back).
 *   - Only UNINDENTED `key: value` lines start a key — nested blocks (e.g. the
 *     `metadata:` maps several catalogs carry) are ignored, and an indented
 *     `name:` can never hijack the top-level one.
 *   - A value may be a YAML block scalar (`|`, `>`, `>-`, `|-`, `|+`, `>+`) or
 *     plain text continued on indented lines. Real catalogs write long
 *     descriptions that way: `canvas` and `graphify` both fold with `>-`.
 *     Reading only the marker line turned an entire description into the
 *     literal `">-"`, which is what the skills prompt then showed the model —
 *     and what the skills cards rendered. Folded (`>`) joins with spaces,
 *     literal (`|`) keeps the line breaks.
 *   - Values are unquoted (see unquote) and NOT otherwise interpreted.
 *   - Everything after the closing `---` is the body, verbatim.
 *
 * @param {string} text raw SKILL.md contents
 */
export function parseSkillMd(text) {
  const raw = String(text ?? "");
  const lines = raw.split(/\r?\n/);
  // Frontmatter must start on the very first line to be frontmatter.
  if (!lines.length || lines[0].trim() !== "---") {
    return { name: "", description: "", body: raw };
  }
  let name = "";
  let description = "";
  let close = -1; // index of the closing `---` line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "---") {
      close = i;
      break;
    }
    // Top-level keys only: `key: value` with no leading whitespace. Once a
    // value for a key is seen, later repeats do not overwrite (first wins,
    // matching how the catalogs use them).
    const match = /^(name|description):\s*(.*)$/i.exec(line);
    if (!match) continue;

    const key = match[1].toLowerCase();
    const inline = match[2].trim();
    const blockMarker = /^[|>][-+]?$/.test(inline) ? inline : null;

    // Continuation lines: indented, non-empty lines up to the next top-level
    // key or the closing `---`. Only consumed when they actually exist.
    const continued = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j];
      if (next.trim() === "---") break;
      if (!next.trim()) {
        continued.push("");
        continue;
      }
      if (!/^\s/.test(next)) break;
      continued.push(next.trim());
    }
    const hasContinuation = continued.some((chunk) => chunk !== "");

    let value;
    if (blockMarker) {
      value = blockMarker.startsWith(">")
        ? continued.filter(Boolean).join(" ")   // folded scalars read as prose
        : continued.join("\n").trim();          // literal keeps its breaks
    } else {
      value = [unquote(inline), ...continued].filter(Boolean).join(" ").trim();
    }

    if (key === "name") {
      if (!name) name = value;
    } else if (!description) {
      description = value;
    }

    // Skip past the lines just consumed so they are not re-read as keys.
    if (blockMarker || hasContinuation) i = j - 1;
  }
  if (close === -1) {
    // Unterminated frontmatter block — treat as no frontmatter (fail-open).
    return { name: "", description: "", body: raw };
  }
  const body = lines.slice(close + 1).join("\n");
  return { name, description, body };
}

// SHA-256 hex of a buffer — used to fingerprint SKILL.md files so the report
// can show whether two same-name skills are actually the same bytes.
function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

// ─── Scanning ────────────────────────────────────────────────────────────────

/**
 * Scan a skills catalog directory.
 *
 * One entry per DIRECT child directory that contains a SKILL.md. Dot-directories
 * (like payloads/skills/.system — the harness's own marker + system skills, per
 * that dir's README.md) are never treated as importable content; the same rule
 * naturally excludes loose files such as the ADDED-SKILLS.md ledger and the
 * flat `<name>-SKILL.md` scratch copies that sit next to the real dirs.
 *
 * The frontmatter `name` is used when present; when it is missing or empty the
 * directory name stands in (payloads README: renaming dirs does not require
 * editing SKILL.md, so both spellings are legitimate identities).
 *
 * Ordering is deterministic: sorted by dirName. This is what makes the
 * merge policy's "first wins" reproducible run over run (CONFLICT.md:
 * internal duplicates resolve to the first entry in directory order).
 *
 * @param {string} dir catalog directory to scan
 * @returns {Array<{dirName:string,name:string,description:string,path:string,sha256:string}>}
 */
export function scanSourceDir(dir) {
  const root = resolve(String(dir || ""));
  if (!existsSync(root)) return [];
  let dirents;
  try {
    dirents = readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // unreadable dir → nothing discovered (fail-open, no throw)
  }
  const entries = [];
  for (const dirent of dirents) {
    // Directories only, and never dot-dirs (`.system`, `.extract-tmp`, …).
    if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
    const dirPath = join(root, dirent.name);
    const skillMdPath = join(dirPath, "SKILL.md");
    if (!existsSync(skillMdPath)) continue; // not a skill dir — not importable
    // A skill dir we cannot read is still a dir with a SKILL.md: keep the
    // entry with fallback identity so the report can name it (fail-open).
    let name = dirent.name;
    let description = "";
    let hash = "";
    try {
      const buf = readFileSync(skillMdPath);
      hash = sha256Hex(buf);
      const parsed = parseSkillMd(buf.toString("utf8"));
      if (parsed.name) name = parsed.name;
      description = parsed.description || "";
    } catch {
      // Leave fallbacks; hash stays empty. Never abort the scan for one dir.
    }
    entries.push({
      dirName: dirent.name,
      name,
      description,
      path: dirPath,
      sha256: hash,
    });
  }
  entries.sort((a, b) => (a.dirName < b.dirName ? -1 : a.dirName > b.dirName ? 1 : 0));
  return entries;
}

// ─── Merging (the CONFLICT.md policy) ────────────────────────────────────────

/**
 * Merge incoming skills against what is already installed.
 *
 * Policy (payloads/CONFLICT.md, verbatim intent):
 *   1. A pre-existing entry wins. Any incoming skill whose frontmatter name
 *      already exists — case-insensitively — in `existing` is SKIPPED, never
 *      overwritten, never renamed. The conflict record carries BOTH sides'
 *      names plus the existing side's source path.
 *   2. Same-name duplicates inside `incoming` itself: the first one wins and
 *      the rest are skipped. "First" is the scan order (dirName-sorted, see
 *      scanSourceDir), so this is deterministic — the alphabetical-first
 *      directory wins, exactly like the category-path rule in CONFLICT.md.
 *
 * @param {Array} incoming scanSourceDir() output for the source catalog
 * @param {Array} existing scanSourceDir() output for the install destination
 * @returns {{toInstall:Array,toSkip:Array,conflicts:Array}}
 *   toInstall/toSkip carry the scan entries; conflicts carry
 *   { reason, incomingName, incomingDirName, incomingPath, existingName, existingPath }.
 */
export function mergeSkills(incoming, existing) {
  const inc = Array.isArray(incoming) ? incoming : [];
  const exi = Array.isArray(existing) ? existing : [];

  // Case-insensitive name index of what is already installed. Names come from
  // frontmatter (or dirName fallback — scanSourceDir already normalized that).
  const existingByName = new Map();
  for (const entry of exi) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    if (!existingByName.has(entry.name.toLowerCase())) {
      existingByName.set(entry.name.toLowerCase(), entry);
    }
  }

  const toInstall = [];
  const toSkip = [];
  const conflicts = [];
  // First-seen index of incoming names (case-insensitive) for rule 2.
  const seenIncoming = new Map();

  for (const entry of inc) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    const key = entry.name.toLowerCase();

    // Rule 1 — pre-existing wins.
    const incumbent = existingByName.get(key);
    if (incumbent) {
      toSkip.push(entry);
      conflicts.push({
        reason: "existing-wins",
        incomingName: entry.name,
        incomingDirName: entry.dirName,
        incomingPath: entry.path,
        existingName: incumbent.name,
        existingPath: incumbent.path || "",
      });
      continue;
    }

    // Rule 2 — internal duplicates: first (dirName order) wins.
    const kept = seenIncoming.get(key);
    if (kept) {
      toSkip.push(entry);
      conflicts.push({
        reason: "internal-duplicate",
        incomingName: entry.name,
        incomingDirName: entry.dirName,
        incomingPath: entry.path,
        existingName: kept.name,
        existingPath: kept.path || "",
      });
      continue;
    }

    seenIncoming.set(key, entry);
    toInstall.push(entry);
  }

  return { toInstall, toSkip, conflicts };
}

// ─── Installing ──────────────────────────────────────────────────────────────

// A skill's frontmatter `name` doubles as its destination directory name
// (destDir/<name>/). Names come from catalog frontmatter — untrusted DATA —
// so they must be a single safe path segment before they can touch the
// filesystem: letters/digits/dot/dash/underscore, no separators, no "..".
// Everything the real catalogs use (kebab-case ids) passes; anything else is
// refused and recorded rather than crashing the run.
function isSafeDestSegment(name) {
  return typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== "..";
}

/**
 * Install skills by copying each source dir into <destDir>/<name>/.
 *
 * - The WHOLE dir tree is copied byte-exact (SKILL.md plus any siblings the
 *   dir carries — references/, scripts/, examples/, …). node:fs cpSync does
 *   the recursive copy; no shell, no archiver, no transformation. Skill
 *   content is never read, executed or evaluated — only hashed and copied.
 * - An existing destination dir is NEVER overwritten: the skill is skipped
 *   and recorded (the CONFLICT.md "pre-existing wins" rule, enforced again at
 *   copy time — two scanners can race, the filesystem check is the last word).
 *
 * @param {Array} list scan entries (from mergeSkills().toInstall)
 * @param {{destDir:string}} opts install destination
 * @returns {{installed:Array,skipped:Array,errors:Array}}
 */
export function installSkills(list, opts = {}) {
  const destDir = resolve(String(opts.destDir || ""));
  const items = Array.isArray(list) ? list : [];
  const installed = [];
  const skipped = [];
  const errors = [];
  if (!destDir || destDir === sep) {
    return { installed, skipped, errors: [{ name: "", error: "no destination configured" }] };
  }

  for (const entry of items) {
    try {
      if (!entry || !entry.path) {
        errors.push({ name: entry?.name || "", error: "scan entry without a source path" });
        continue;
      }
      // Frontmatter name names the dest dir; dirName is the fallback (the two
      // are the same for everything in the payloads catalog).
      const baseName = isSafeDestSegment(entry.name) ? entry.name : null;
      const fallback = isSafeDestSegment(entry.dirName) ? entry.dirName : null;
      const dest = join(destDir, baseName || fallback || "");
      if (!dest || !resolve(dest).startsWith(resolve(destDir) + sep)) {
        errors.push({ name: entry.name, error: `unsafe destination name: "${entry.name}"` });
        continue;
      }
      // Refuse to overwrite: whatever is already at <name>/ stays.
      if (existsSync(dest)) {
        skipped.push({ name: entry.name, dirName: entry.dirName, reason: "dest-exists", dest });
        continue;
      }
      mkdirSync(destDir, { recursive: true });
      // Byte-exact recursive dir copy. Errors here are per-skill: record and
      // move on — one broken skill dir never blocks the rest (fail-open).
      cpSync(entry.path, dest, { recursive: true });
      installed.push({ name: entry.name, dirName: entry.dirName, dest });
    } catch (err) {
      errors.push({ name: entry?.name || "", error: err?.message || String(err) });
    }
  }
  return { installed, skipped, errors };
}

// ─── Run-level glue (what the API route calls) ───────────────────────────────
//
// runScan / runInstall resolve the source dir (settings → default) and the
// dest dir (DATA_DIR/skills), then run the pure functions above. Both accept
// explicit overrides ({ sourceDir, destDir }) so tests can run hermetically
// against temp dirs without touching settings or the real data dir.

async function resolveDestDir(override) {
  if (override && String(override).trim()) return resolve(String(override).trim());
  return defaultDestDir();
}

// Validate the source dir BEFORE anything else touches the pipeline: it must
// exist and be a directory. Anything else is an Error the route turns into a
// 400 with the path in the message.
function assertSourceDir(sourceDir) {
  const src = resolve(String(sourceDir || ""));
  let stat = null;
  try {
    stat = statSync(src);
  } catch {
    /* missing → handled below */
  }
  if (!stat || !stat.isDirectory()) {
    throw new Error(`skills source dir not found: ${src}`);
  }
  return src;
}

/**
 * Scan + merge WITHOUT writing anything. Returns the full merge report.
 * Safe to call repeatedly — it only reads the source and destination.
 */
export async function runScan(opts = {}) {
  const sourceDir = assertSourceDir(
    opts.sourceDir && String(opts.sourceDir).trim() ? opts.sourceDir : await resolveSourceDir(),
  );
  const destDir = await resolveDestDir(opts.destDir);
  // Existing installs are scanned with the same scanner as the source, so
  // both sides of the merge speak the same entry shape.
  const incoming = scanSourceDir(sourceDir);
  const existing = scanSourceDir(destDir);
  const { toInstall, toSkip, conflicts } = mergeSkills(incoming, existing);
  return {
    source: sourceDir,
    destDir,
    sourceExists: true,
    discovered: incoming.length,
    existing: existing.length,
    toInstallCount: toInstall.length,
    toSkipCount: toSkip.length,
    toInstall, // full entries — the UI previews what WOULD land
    toSkip,
    conflicts,
  };
}

// Persist lastRun (and the scan snapshot it came from) into settings under the
// skillsPipeline key. Shallow top-level merge in updateSettings means we must
// carry the rest of the skillsPipeline object ourselves.
async function persistRunState(patch) {
  try {
    const { getSettings, updateSettings } = await import("@/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    const current = settings?.skillsPipeline || {};
    await updateSettings({ skillsPipeline: { ...current, ...patch } });
  } catch {
    // Settings persistence is best-effort: the install already happened on
    // disk, and a failed bookkeeping write must not fail the run (fail-open).
  }
}

/**
 * Full run: scan → merge → copy. Writes ONLY into destDir; never overwrites.
 * Persists { lastRun, lastReport } into settings for the GET surface.
 */
export async function runInstall(opts = {}) {
  const report = await runScan(opts);
  const result = installSkills(report.toInstall, { destDir: report.destDir });
  const at = new Date().toISOString();
  const lastRun = {
    at,
    action: "install",
    source: report.source,
    destDir: report.destDir,
    discovered: report.discovered,
    installed: result.installed.length,
    skipped: result.skipped.length + report.toSkipCount,
    errors: result.errors.length,
  };
  await persistRunState({
    lastRun,
    // Small snapshot for the dashboard: counts plus the conflict ledger.
    lastReport: {
      at,
      source: report.source,
      discovered: report.discovered,
      conflicts: report.conflicts,
      skipped: report.toSkip.map((s) => ({ name: s.name, dirName: s.dirName })),
    },
  });
  return { ...report, install: result, lastRun };
}

/**
 * Install exactly one skill by (case-insensitive) name. Reuses the same
 * scan → merge machinery so the single skill still obeys every CONFLICT.md
 * rule — an existing entry or a name already claimed inside the source means
 * a skip, not an overwrite.
 */
export async function installOne(rawName, opts = {}) {
  const wanted = String(rawName || "").trim().toLowerCase();
  if (!wanted) throw new Error("install-one requires a skill name");
  const report = await runScan(opts);
  const match = report.toInstall.find((s) => s.name.toLowerCase() === wanted);
  const at = new Date().toISOString();
  if (!match) {
    const known = report.toSkip.find((s) => s.name.toLowerCase() === wanted);
    const lastRun = {
      at,
      action: "install-one",
      source: report.source,
      destDir: report.destDir,
      installed: 0,
      skipped: 1,
      errors: 0,
      reason: known ? "conflict" : "not-found",
    };
    await persistRunState({ lastRun });
    return { ...report, install: { installed: [], skipped: [known || { name: rawName, reason: "not-found" }], errors: [] }, lastRun };
  }
  const result = installSkills([match], { destDir: report.destDir });
  const lastRun = {
    at,
    action: "install-one",
    source: report.source,
    destDir: report.destDir,
    installed: result.installed.length,
    skipped: result.skipped.length,
    errors: result.errors.length,
  };
  await persistRunState({ lastRun });
  return { ...report, install: result, lastRun };
}

/**
 * Status for GET: configured source, destination, what is installed now, and
 * the last persisted run. The live scan is included when it works; a bad
 * source dir degrades to an error note instead of a 500 (fail-open) — the
 * page stays usable and can still fix the source via settings.
 */
export async function pipelineStatus(opts = {}) {
  const sourceDir = opts.sourceDir && String(opts.sourceDir).trim()
    ? resolve(String(opts.sourceDir).trim())
    : await resolveSourceDir();
  const destDir = await resolveDestDir(opts.destDir);
  let lastRun = null;
  let lastReport = null;
  try {
    const { getSettings } = await import("@/lib/db/repos/settingsRepo.js");
    const settings = await getSettings();
    lastRun = settings?.skillsPipeline?.lastRun || null;
    lastReport = settings?.skillsPipeline?.lastReport || null;
  } catch { /* settings unavailable — still report the filesystem truth */ }

  let installedNames = [];
  try {
    installedNames = scanSourceDir(destDir).map((s) => s.name);
  } catch { /* dest unreadable → treated as empty */ }

  let scan = null;
  let scanError = "";
  try {
    scan = await runScan({ sourceDir, destDir });
  } catch (err) {
    scanError = err?.message || String(err);
  }

  return {
    source: sourceDir,
    sourceExists: !scanError,
    destDir,
    discovered: scan ? scan.discovered : 0,
    installed: installedNames.length,
    installedNames,
    skipped: scan ? scan.toSkipCount : 0,
    conflicts: scan ? scan.conflicts : [],
    scanError,
    lastRun,
    lastReport,
  };
}
