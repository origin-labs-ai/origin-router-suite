// Combo seat audit: test every member of a combo through the honest model-test
// endpoint, recheck on timeout, and drop only the seats that definitively error.
//
//   node scripts/combo-seat-audit.mjs [comboName] [--apply]
//   node scripts/combo-seat-audit.mjs [comboName] --drop=seatA,seatB
//   node scripts/combo-seat-audit.mjs [comboName] --policy=free-working [--apply]
//
// Without --apply nothing is written: the script only reports. --drop re-probes
// only the named seats and removes those that still refuse, so an earlier audit can
// be acted on without hammering the whole combo a second time. --policy=free-working
// keeps a seat only when it is declared free AND answers now. The current member
// list is always backed up to <DATA_DIR>/combo-backups before any change.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { getPricingForModel, isFreeModel } from "../open-sse/providers/pricing.js";

const args = process.argv.slice(2);
const COMBO_NAME = args.find((a) => !a.startsWith("--")) || "claude-opus-5-5";
const APPLY = args.includes("--apply");
const dropArg = args.find((a) => a.startsWith("--drop="));
const DROP_LIST = dropArg
  ? dropArg.slice("--drop=".length).split(",").map((s) => s.trim()).filter(Boolean)
  : null;
const policyArg = args.find((a) => a.startsWith("--policy="));
const POLICY = policyArg ? policyArg.slice("--policy=".length) : null;
const ALL_COMBOS = args.includes("--all-combos");
const restoreArg = args.find((a) => a.startsWith("--restore="));
const RESTORE = restoreArg ? restoreArg.slice("--restore=".length) : null;

const BASE = process.env.OR_BASE || "http://127.0.0.1:20127";
const DATA_DIR = process.env.ORIGINROUTER_DATA_DIR || path.join(os.homedir(), ".or");

const MAX_ATTEMPTS = 3;        // a timeout or transient refusal is re-checked, not believed once
const RETRY_PAUSE_MS = 4000;
const CONCURRENCY = 4;         // the router serves 8 agents; leave headroom for live traffic
const CLIENT_TIMEOUT_MS = 45000;

// The seat cannot serve this model id. This is the only evidence strong enough to
// remove a member, and it must be confirmed twice.
const MODEL_LEVEL = [
  "model_not_found",
  "model not found",
  "does not exist",
  "no such model",
  "could not find model",
  "no model named",
  "unknown model",
  "unsupported model",
  "not a supported model",
  "not a valid model",
  "invalid model",
  "model_unpriced_or_unavailable",
  "not priced or available",
  "model is unavailable",
  "unavailable for free",
  "free launch period",
  "no completion choices",
  "empty completion",
];
// The provider itself is not connected: nothing can serve any seat under it.
const PROVIDER_ROUTE_LEVEL = ["no active credentials", "invalid model format"];
// Account/health answers. The model may be perfectly fine; the seat is busy,
// broke, or the router wrapped a retryable fault. Never a reason to delete.
// Note: a wrapped error text always starts with "HTTP 503:", so these phrases are
// checked only after MODEL_LEVEL — otherwise every refusal looks transient.
const TRANSIENT = [
  "rate limit", "rate_limit", "too many", "overloaded", "cooldown", "locked",
  "temporarily", "service t", "bad gateway", "gateway time", "free allowance",
  "allowance", "quota", "credits", "payment required", "insufficient",
  "upgrade", "your plan", "402", "403", "429", "500", "502", "503", "504",
  "timeout", "timed out", "connection", "econn", "socket",
];

const cliToken = (() => {
  const raw = fs.readFileSync(path.join(DATA_DIR, "machine-id"), "utf8").trim();
  let secret = "";
  try {
    secret = fs.readFileSync(path.join(DATA_DIR, "auth", "cli-secret"), "utf8").trim();
  } catch { /* older installs derive the token from the machine id alone */ }
  return crypto.createHash("sha256").update(raw + "9r-cli-auth" + secret).digest("hex").substring(0, 16);
})();

const HEADERS = { "Content-Type": "application/json", "x-9r-cli-token": cliToken };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const classifyText = (haystack, needles) => needles.some((n) => haystack.includes(n));

/**
 * Is this seat free? Declared evidence only, in this order:
 *   1. the pricing table's declared free namespace (isFreeModel),
 *   2. a free-variant id handed out by the upstream catalog (`:free`, `-free`,
 *      `…0731free`): the aggregator names and meters these at $0. This must be
 *      checked before any rate lookup — getPricingForModel() strips the vendor
 *      prefix, so "deepseek/deepseek-v4-flash-free" would otherwise inherit the
 *      PAID rate of "deepseek-v4-flash" and a free seat would look expensive.
 *      (Exactly the trap open-sse/providers/pricing.js documents for cline-free/.)
 *   3. the merged pricing config — the owner's stored rates, then the app's default
 *      table (provider overrides + glob patterns).
 * Anything left over is treated as paid: a seat is never kept by this policy on a
 * guess about its price.
 */
function freenessOf(bareModel, providerKey, storedPricing) {
  const model = String(bareModel || "");

  if (isFreeModel(model)) return { free: true, basis: "declared free namespace" };
  if (/[:-]free\b/i.test(model) || /free\d*$/i.test(model)) {
    return { free: true, basis: "free-variant id from upstream catalog" };
  }

  const row = storedPricing?.[providerKey]?.[model] ?? getPricingForModel(providerKey, model);
  if (row) {
    const input = Number(row.input) || 0;
    const output = Number(row.output) || 0;
    if (input === 0 && output === 0) return { free: true, basis: "pricing table 0/0 per 1M" };
    return { free: false, basis: `paid $${input} in / $${output} out per 1M` };
  }

  return { free: false, basis: "no declared pricing → treated as paid" };
}

async function api(pathname, init) {
  const res = await fetch(`${BASE}${pathname}`, { ...init, headers: HEADERS, signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { }
  return { ok: res.ok, status: res.status, data, text };
}

// One verdict per seat: served | broken | missing-route | transient | timeout | unclear
async function probeOnce(seat) {
  const { status, data, text } = await api("/api/models/test", {
    method: "POST",
    body: JSON.stringify({ model: seat }),
  });
  if (!data || typeof data.ok !== "boolean") {
    return { verdict: "transient", detail: `test endpoint returned HTTP ${status}: ${text.slice(0, 160)}` };
  }
  const error = String(data.error || "");
  const lower = error.toLowerCase();

  if (data.ok) return { verdict: "served", detail: data.note || `${data.latencyMs} ms`, data };
  if (data.timedOut) return { verdict: "timeout", detail: error || "timed out", data };
  if (classifyText(lower, PROVIDER_ROUTE_LEVEL)) return { verdict: "missing-route", detail: error, data };
  if (classifyText(lower, MODEL_LEVEL)) return { verdict: "broken", detail: error, data };
  if (classifyText(lower, TRANSIENT)) return { verdict: "transient", detail: error, data };
  // Unknown wording: reported, never deleted.
  return { verdict: "unclear", detail: error || text.slice(0, 200), data };
}

/**
 * A seat is only called broken when the same verdict arrives twice — a single
 * network blip must never delete a working model. Timeouts and transient refusals
 * are re-checked up to MAX_ATTEMPTS and otherwise left in place, flagged.
 */
async function auditSeat(seat) {
  const attempts = [];
  const counts = { served: 0, broken: 0, "missing-route": 0, transient: 0, timeout: 0, unclear: 0 };

  for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
    const outcome = await probeOnce(seat);
    attempts.push(outcome);
    counts[outcome.verdict] += 1;
    process.stdout.write(`  [${i}/${MAX_ATTEMPTS}] ${seat} → ${outcome.verdict}: ${String(outcome.detail).slice(0, 120)}\n`);

    // A definitive answer ends the walk: no reason to re-check a seat that just
    // served, or a provider that has no connection at all.
    if (outcome.verdict === "served") return { seat, verdict: "served", attempts, detail: outcome.detail };
    if (outcome.verdict === "missing-route") return { seat, verdict: "missing-route", attempts, detail: outcome.detail };

    // Confirm a refusal once more before it counts as proof.
    if (outcome.verdict === "broken" && counts.broken < 2) {
      await sleep(RETRY_PAUSE_MS);
      const again = await probeOnce(seat);
      attempts.push(again);
      counts[again.verdict] += 1;
      process.stdout.write(`  [confirm] ${seat} → ${again.verdict}: ${String(again.detail).slice(0, 120)}\n`);
      if (again.verdict === "served") return { seat, verdict: "served", attempts, detail: again.detail };
      if (again.verdict === "broken") return { seat, verdict: "broken", attempts, detail: again.detail };
      await sleep(RETRY_PAUSE_MS);
      continue;
    }
    if (i < MAX_ATTEMPTS) await sleep(RETRY_PAUSE_MS);
  }

  const last = attempts.at(-1);
  // Slow every single time: nothing refused the model, so the seat is kept and
  // flagged for a recheck rather than deleted on a hunch.
  if (counts.broken === 0 && counts.unclear === 0 && counts.transient === 0 && counts["missing-route"] === 0) {
    return { seat, verdict: "unresolved", attempts, detail: last.detail };
  }
  return { seat, verdict: last.verdict, attempts, detail: last.detail };
}

async function runPool(items, size, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results.push(await worker(items[index]));
    }
  });
  await Promise.all(runners);
  return results;
}

const combosRes = await api("/api/combos", { method: "GET" });
const combo = (combosRes.data?.combos || []).find((c) => c.name === COMBO_NAME);
if (!combo) {
  console.error(`Combo "${COMBO_NAME}" not found. Available: ${(combosRes.data?.combos || []).map((c) => c.name).join(", ")}`);
  process.exit(1);
}

const seats = Array.isArray(combo.models) ? combo.models : [];
const allCombos = combosRes.data?.combos || [];
const comboNames = new Set(allCombos.map((c) => c.name));
const nested = seats.filter((s) => !String(s).includes("/") && comboNames.has(s));

console.log(`\nCombo "${COMBO_NAME}" (id ${combo.id}) — ${seats.length} seats`);
console.log(`kind=${combo.kind || "-"} maxContextWindow=${combo.maxContextWindow || "-"} nestedComboMembers=${nested.length ? nested.join(", ") : "none"}`);
console.log(`mode=${DROP_LIST ? `DROP ${DROP_LIST.length} named seat(s)` : POLICY ? `POLICY ${POLICY}` : RESTORE ? "RESTORE from backup" : APPLY ? "APPLY (members will be removed)" : "DRY RUN (nothing is written)"}\n`);

if (RESTORE) {
  // Undo a prune: write back the member list from a backup this tool took.
  const file = path.isAbsolute(RESTORE) ? RESTORE : path.join(DATA_DIR, "combo-backups", RESTORE);
  let backup;
  try {
    backup = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`Cannot read backup ${file}: ${error.message}`);
    console.error(`Available: ${fs.readdirSync(path.join(DATA_DIR, "combo-backups")).join(", ")}`);
    process.exit(1);
  }
  // A single-combo backup restores that combo; the ALL-combos snapshot restores
  // every combo it contains, skipping ones that no longer exist.
  for (const entry of Array.isArray(backup) ? backup : [backup]) {
    const models = Array.isArray(entry.models) ? entry.models : [];
    if (!models.length) {
      console.log(`${entry.name || "?"}: backup has no members, skipped`);
      continue;
    }
    const target = allCombos.find((c) => c.id === entry.id) || allCombos.find((c) => c.name === entry.name);
    if (!target) {
      console.log(`${entry.name}: combo no longer exists, skipped`);
      continue;
    }
    const put = await api(`/api/combos/${target.id}`, {
      method: "PUT",
      body: JSON.stringify({ ...target, models }),
    });
    console.log(`${target.name}: ${(target.models || []).length} → ${models.length} seats (from ${path.basename(file)}) → HTTP ${put.status}`);
    if (!put.ok) console.error(`  update failed: ${put.text.slice(0, 200)}`);
  }
  process.exit(0);
}

/**
 * Back up the current member list, then write the combo without the removed seats.
 * The backup is written first and its path printed, so any removal is undoable.
 */
async function writeCombo(removeList, target = combo, currentSeats = seats) {
  const remove = new Set(removeList.map((r) => r.seat));
  const keep = currentSeats.filter((s) => !remove.has(s));
  if (remove.size === 0) {
    console.log(`  ${target.name}: nothing to remove — every candidate answered or stayed unresolved.`);
    return null;
  }

  const backupDir = path.join(DATA_DIR, "combo-backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(backupDir, `${target.name}.${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ ...target, models: currentSeats }, null, 2), "utf8");
  console.log(`  backup: ${backupFile}`);

  const put = await api(`/api/combos/${target.id}`, {
    method: "PUT",
    body: JSON.stringify({ ...target, models: keep }),
  });
  console.log(`  PUT /api/combos/${target.id} → HTTP ${put.status}`);
  if (!put.ok) {
    console.error("Update failed:", put.text.slice(0, 400));
    process.exit(1);
  }
  console.log(`  "${target.name}" now has ${keep.length} seats (removed ${remove.size}): ${[...remove].join(", ")}`);
  return keep;
}

if (POLICY === "keep-serving") {
  // The owner's rule, and the root of every symptom in this session: a combo is a
  // fallback list, so it must contain only routes that answer in reality. A seat
  // that is refused, capped, unconnected, or behind a dead key is not a fallback —
  // it is a wasted hop that ends the walk with the last-resort answer.
  const isNestedComboName = (s) => !String(s).includes("/") && comboNames.has(String(s));
  const targets = ALL_COMBOS ? allCombos : [combo];
  for (const target of targets) {
    const current = Array.isArray(target.models) ? target.models : [];
    console.log(`\n=== ${target.name} (${current.length} seats) ===`);
    if (!current.length) {
      console.log("  empty combo, nothing to check");
      continue;
    }
    const verdicts = await runPool(current, CONCURRENCY, auditSeat);
    const keep = [];
    const dropped = [];
    for (const v of verdicts) {
      // A nested combo is a pool of its own; pruning it as if it were a seat would
      // delete the whole pool because one of its members was busy.
      if (v.verdict === "served" || isNestedComboName(v.seat)) keep.push(v);
      else dropped.push(v);
    }
    console.log(`  answering: ${keep.length} · removing: ${dropped.length}`);
    dropped.forEach((d) => console.log(`  DROP ${d.seat}  (${d.verdict}: ${String(d.detail).replace(/\s+/g, " ").slice(0, 110)})`));
    if (!APPLY) {
      console.log(`  dry run: ${current.length} → ${current.length - dropped.length} seats`);
      continue;
    }
    await writeCombo(dropped, target, current);
    if (keep.length === dropped.length) {
      console.log(`  NOTE ${target.name} is now EMPTY — anything naming it gets the last-resort answer.`);
    }
  }
  process.exit(0);
}

if (DROP_LIST) {
  // Act on a previous audit without hammering the whole combo again. A named seat is
  // removed only when it still cannot serve: a model-level refusal, or a provider
  // with no connection behind it. Anything that answers, stalls, or reports a quota
  // is a live seat and stays.
  const unknown = DROP_LIST.filter((s) => !seats.includes(s));
  if (unknown.length) console.log(`not members of this combo, skipped: ${unknown.join(", ")}`);
  const removable = new Set(["broken", "missing-route"]);
  const confirmed = [];
  for (const seat of DROP_LIST.filter((s) => seats.includes(s))) {
    const verdict = await auditSeat(seat);
    if (removable.has(verdict.verdict)) confirmed.push(verdict);
    else console.log(`  kept ${seat}: now ${verdict.verdict} — not removing`);
  }
  await writeCombo(confirmed);
  process.exit(0);
}

if (POLICY === "free-working") {
  // Owner's rule: the combo carries only seats that are free AND answer right now.
  // Price comes from declared data (pricing config/table, then the upstream's own
  // free-variant id), never from a name guess about the model's class.
  const catalog = await api("/api/models", { method: "GET" });
  const rows = catalog.data?.models || [];
  const bySeat = new Map(rows.map((m) => [m.routedModel || `${m.provider}/${m.model}`, m]));
  const storedPricing = (await api("/api/pricing", { method: "GET" })).data || {};

  const classified = seats.map((seat) => {
    const row = bySeat.get(seat);
    const bare = row?.model ?? String(seat).split("/").slice(1).join("/");
    // Try the catalog's provider id first, then the seat's own prefix: aggregators
    // price the same model under either key.
    for (const key of [row?.provider, String(seat).split("/")[0]].filter(Boolean)) {
      const v = freenessOf(bare, key, storedPricing);
      if (v.free) return { seat, bare, providerKey: key, ...v, inCatalog: Boolean(row) };
    }
    return { seat, bare, ...freenessOf(bare, row?.provider || String(seat).split("/")[0], storedPricing), inCatalog: Boolean(row) };
  });

  const freeSeats = classified.filter((c) => c.free);
  console.log(`declared free: ${freeSeats.length}/${classified.length} (catalog rows: ${classified.filter((c) => c.inCatalog).length})`);

  const working = new Map((await runPool(freeSeats.map((c) => c.seat), CONCURRENCY, auditSeat)).map((v) => [v.seat, v]));

  const keep = [];
  const removeList = [];
  for (const c of classified) {
    if (!c.free) {
      removeList.push({ ...c, why: `not free (${c.basis})` });
      continue;
    }
    const v = working.get(c.seat);
    if (v?.verdict === "served") {
      keep.push({ ...c, detail: v.detail });
      continue;
    }
    removeList.push({ ...c, why: `free but not answering (${v?.verdict}: ${String(v?.detail).replace(/\s+/g, " ").slice(0, 130)})` });
  }

  console.log(`\nKEEP ${keep.length} · REMOVE ${removeList.length}`);
  keep.forEach((k) => console.log(`  KEEP   ${k.seat}  [${k.basis}] ${k.detail}`));
  removeList.forEach((r) => console.log(`  REMOVE ${r.seat}  ${r.why}`));

  if (!APPLY) {
    console.log(`\nDRY RUN — would go ${seats.length} → ${keep.length} seats. Re-run with --apply to write.`);
    process.exit(0);
  }
  await writeCombo(removeList);
  process.exit(0);
}

const results = await runPool(seats, CONCURRENCY, async (seat) => {
  if (nested.includes(seat)) {
    // A nested combo is a whole routing pool, not one model. Auditing it as a seat
    // would blame the combo for a single member, so it is reported and kept.
    process.stdout.write(`  [skip] ${seat} is a nested combo — kept, not seat-audited\n`);
    return { seat, verdict: "nested-combo", attempts: [], detail: "nested combo member" };
  }
  return auditSeat(seat);
});

const by = (v) => results.filter((r) => r.verdict === v);
const served = by("served");
const broken = by("broken");
const missingRoute = by("missing-route");
const unresolved = by("unresolved");
const timedOut = by("timeout");
const transient = by("transient");
const unclear = by("unclear");
const nestedCombo = by("nested-combo");

// Every seat must land in exactly one bucket. Without this a verdict that no bucket
// prints disappears from the report while still sitting in the combo — the count
// looks fine and the evidence is gone.
const buckets = [served, broken, missingRoute, unresolved, timedOut, transient, unclear, nestedCombo];
const accounted = buckets.reduce((sum, list) => sum + list.length, 0);
if (accounted !== seats.length) {
  console.error(`\nBUG: ${accounted} verdicts for ${seats.length} seats — a bucket is missing.`);
  const known = new Set(buckets.flat().map((r) => r.seat));
  console.error(`unaccounted: ${seats.filter((s) => !known.has(s)).join(", ") || "none"}`);
}

console.log("\n══════════ VERDICT ══════════");
console.log(`served working         : ${served.length}`);
console.log(`broken confirmed       : ${broken.length}  ${broken.map((r) => r.seat).join(", ") || "-"}`);
console.log(`missing provider route : ${missingRoute.length}  ${missingRoute.map((r) => r.seat).join(", ") || "-"}`);
console.log(`unresolved (timeouts)  : ${unresolved.length}  ${unresolved.map((r) => r.seat).join(", ") || "-"}`);
console.log(`last attempt timeout   : ${timedOut.length}  ${timedOut.map((r) => r.seat).join(", ") || "-"}`);
console.log(`transient (busy/quota) : ${transient.length}  ${transient.map((r) => r.seat).join(", ") || "-"}`);
console.log(`unclear wording        : ${unclear.length}  ${unclear.map((r) => r.seat).join(", ") || "-"}`);
console.log(`nested combos kept     : ${nestedCombo.length}  ${nestedCombo.map((r) => r.seat).join(", ") || "-"}`);

const section = (title, rows) => {
  if (!rows.length) return;
  console.log(`\n── ${title} ──`);
  rows.forEach((r) => console.log(`  ${r.seat}: ${String(r.detail).slice(0, 220).replace(/\s+/g, " ")}`));
};
section("broken (proof the seat cannot serve this model)", broken);
section("missing provider route (provider not connected)", missingRoute);
section("unresolved — only timed out, kept in the combo", unresolved);
section("timed out on the last attempt — kept, recheck later", timedOut);
section("transient — busy/quota/lock, kept in the combo", transient);
section("unclear wording — kept in the combo, needs a human look", unclear);

const brokenSeats = new Set(broken.map((r) => r.seat));
if (!APPLY) {
  console.log(`\nDRY RUN — would keep ${seats.length - brokenSeats.size}/${seats.length} seats. Re-run with --apply to write the change.`);
  process.exit(0);
}

await writeCombo(broken);
