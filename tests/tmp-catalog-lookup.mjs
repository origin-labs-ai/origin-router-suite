// Precise lookup: does any upstream catalog record exist for these model ids, and
// what caps do the owner's own custom model rows carry? Answers "is 200K really
// this model's ceiling, or is it our guess".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const IDS = [
  "intern/Atria-Dawn", "kios/atria-dawn", "or/tencent/hy4-preview-free", "or/tencent/hy4-preview",
  "qd/qfmodel", "or/deepseek/deepseek-chat", "or/sakana/fugu-max", "or/sakana/fugu-ultra",
  "or/sakana/fugu-ultra-v2", "oc/deepseek-v4.1-flash-free", "deepseek-flash", "deepseek-pro",
  "qwen3.8-omni-flash", "glm-5.2", "hy4", "atria-dawn", "fugu", "qfmodel",
];

function walk(node, trail, out) {
  if (Array.isArray(node)) {
    node.forEach((item, i) => walk(item, trail, out));
    return;
  }
  if (node && typeof node === "object") {
    const id = node.id || node.model || node.slug || node.name;
    if (typeof id === "string") {
      const numbers = Object.fromEntries(Object.entries(node)
        .filter(([, value]) => typeof value === "number" && /context|token|length|window/i.test(String(value) + "") || (typeof value === "number")));
      out.push({ id, keys: Object.keys(node).join(","), numbers });
    }
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === "object") walk(value, [...trail, key], out);
    }
  }
}

const files = ["model-catalog.json", "model-catalog-raw.json"];
const records = [];
for (const file of files) {
  const full = path.join(os.homedir(), ".or", file);
  if (!fs.existsSync(full)) continue;
  const parsed = JSON.parse(fs.readFileSync(full, "utf8"));
  const bucket = [];
  walk(parsed, [file], bucket);
  console.log(`${file}: ${bucket.length} model-ish records`);
  records.push(...bucket.map((r) => ({ ...r, file })));
}

console.log("\n=== upstream records for the flagged ids ===");
for (const needle of IDS) {
  const tail = needle.includes("/") ? needle.slice(needle.indexOf("/") + 1) : needle;
  const hits = records.filter((r) => r.id.toLowerCase().includes(tail.toLowerCase()));
  if (hits.length === 0) {
    console.log(`  ${needle.padEnd(34)} NO upstream catalog record`);
    continue;
  }
  for (const hit of hits.slice(0, 2)) {
    const ctx = Object.entries(hit.numbers || {}).filter(([k]) => /context|token|length/i.test(k));
    console.log(`  ${needle.padEnd(34)} ${hit.file} id=${hit.id} ${ctx.map(([k, v]) => `${k}=${v.toLocaleString("en-US")}`).join(" ") || "(no context field)"} keys[${hit.keys}]`);
  }
}

const db = new DatabaseSync(path.join(os.homedir(), ".or", "db", "data.sqlite"), { readOnly: true });
const kv = db.prepare("select key, value from kv where key like '%|llm'").all();
db.close();

console.log("\n=== owner's custom model rows (declared caps) ===");
for (const row of kv) {
  let entries = [];
  try { entries = JSON.parse(row.value); } catch { continue; }
  if (!Array.isArray(entries)) entries = [entries];
  for (const entry of entries) {
    const id = String(entry?.id || "");
    const name = String(entry?.name || "");
    if (!IDS.some((needle) => {
      const tail = needle.includes("/") ? needle.slice(needle.indexOf("/") + 1) : needle;
      return id.toLowerCase().includes(tail.toLowerCase()) || name.toLowerCase().replace(/\s+/g, "").includes(tail.toLowerCase().replace(/[^a-z0-9]/g, ""));
    })) continue;
    console.log(`  ${row.key.split("|")[0].padEnd(12)} id=${id.padEnd(28)} name=${name.padEnd(22)} caps=${JSON.stringify(entry.caps || entry || null).slice(0, 120)}`);
  }
}
