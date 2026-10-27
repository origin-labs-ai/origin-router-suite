#!/usr/bin/env node
/**
 * Brand + upsell audit.
 *
 * Fails when user-visible copy still references the upstream brand, the paid
 * plans, or the surfaces we deliberately do not ship (login, pricing, upgrade).
 * Provider protocol ids like `anthropic-compatible-*` are allowed: they are
 * wire-format names, not branding.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "desktop"];
const ALLOW_LINE = [
  /anthropic-compatible/i,
  /anthropic[-_]?(claude|messages|beta|version|sdk)/i,
  /ANTHROPIC_[A-Z_]+/,
  /anthropic\.com\/v1/,
  /@anthropic/i,
  /"anthropic"/,
  /legacy migration path/i,
  /font-family:.?Anthropic/i,
];

const FORBIDDEN = [
  { id: "upstream-brand", pattern: /9Router|9router/g },
  { id: "anthropic-brand", pattern: /Anthropic(?![-_ ]?(?:compatible|Claude|messages|beta|version|Sdk|SDK))/g },
  { id: "upgrade", pattern: /\b(Upgrade|upgrade to Pro|Pro plan|Max plan)\b/g },
  { id: "cowork", pattern: /Claude Cowork/g },
  { id: "claude-code-gate", pattern: /Claude Code (?:is )?(?:not available|requires|upgrade)/g },
];

const EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".css", ".json", ".md"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".next-cli-build", ".git", "dist", "app"]);

const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;

    const text = fs.readFileSync(full, "utf8");
    text.split("\n").forEach((line, index) => {
      if (ALLOW_LINE.some((allowed) => allowed.test(line))) return;
      for (const rule of FORBIDDEN) {
        if (rule.id === "anthropic-brand" && !/["'`][^"'`]*Anthropic/.test(line)) continue;
        rule.pattern.lastIndex = 0;
        const match = rule.pattern.exec(line);
        if (!match) continue;
        findings.push({ file: full, line: index + 1, rule: rule.id, text: line.trim().slice(0, 120) });
      }
    });
  }
}

for (const root of ROOTS) {
  if (fs.existsSync(root)) walk(root);
}

if (findings.length === 0) {
  console.log("brand audit: clean");
  process.exit(0);
}

const strict = process.argv.includes("--strict");
console.error(`brand audit: ${findings.length} finding(s)${strict ? "" : " (warnings only, use --strict to fail)"}`);
for (const finding of findings.slice(0, 60)) {
  console.error(`  ${finding.file}:${finding.line} [${finding.rule}] ${finding.text}`);
}
process.exit(1);
