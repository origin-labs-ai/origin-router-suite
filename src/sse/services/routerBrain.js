// Router brain — the single gate in front of the two routing decision-makers.
//
//   panda   → PandaOrchestrator only (calibrated P(success) / cost / latency)
//   jev     → System One (Jev) only (semantic task classification)
//   merged  → both, in parallel, scores blended
//
// Why one gate: the two brains used to decide in isolation. Panda ordered the combo
// seats in chat.js, Jev re-ordered them again inside handleComboChat, and neither
// knew the other existed — so the second silently undid the first. Here every seat
// gets one blended score built from four things:
//
//   Panda's calibrated success/cost  ×  pandaWeight
//   Jev's task-level judgement       ×  jevWeight
//   the model's class (Pro / Flash)  ×  tierBias      (hard task → heavy model)
//   and a fairness pass                                    (no seat left idle)
//
// Nothing in here may ever fail a request. A brain that is down, slow or unsure
// returns nothing and the blend uses whatever did answer; if neither did, the owner's
// own seat order is used.
import { rankStrings } from "./pandaRouter.js";
import { resolveSmartChoice } from "./systemoneRouter.js";
import { isDegraded } from "./routeHealth.js";
import { normalizeRouterBrain } from "@/lib/routingPolicy";
import { modelNameFor } from "@/lib/modelNameIndex.js";
import { modelTier, TIER_FLASH } from "@/shared/utils/modelTier.js";

// A seat Panda ranked but gave no probability for is still better than one it did
// not recognise: score it by rank position so order is preserved without inventing a
// success rate.
const DECAY_BASE = 0.78;
// Panda has no card for this seat (unknown model). Neutral-low, not zero: it is a
// real seat the owner added, it just cannot be graded yet.
const UNRANKED_PANDA = 0.12;

// Running totals, so "which brain actually decided?" is a question with a number as
// an answer instead of a claim. Kept on globalThis because every Next route is its own
// bundle: a module-level object would give the status route its own private zeros.
function statsStore() {
  if (typeof globalThis === "undefined") return null;
  if (!globalThis.__orBrainStats) {
    globalThis.__orBrainStats = {
      pandaDecisions: 0,
      jevDecisions: 0,
      blends: 0,
      fairnessPromotions: 0,
      tierSteered: 0,
      byMode: { panda: 0, jev: 0, merged: 0 },
      chosenSeats: new Map(),
    };
  }
  return globalThis.__orBrainStats;
}

const EMPTY_STATS = {
  pandaDecisions: 0, jevDecisions: 0, blends: 0, fairnessPromotions: 0, tierSteered: 0,
  byMode: { panda: 0, jev: 0, merged: 0 }, chosenSeats: new Map(),
};

function bump(field, by = 1) {
  const stats = statsStore() || EMPTY_STATS;
  stats[field] = (stats[field] || 0) + by;
}

function bumpMode(mode) {
  const stats = statsStore() || EMPTY_STATS;
  if (!stats.byMode) stats.byMode = { panda: 0, jev: 0, merged: 0 };
  stats.byMode[mode] = (stats.byMode[mode] || 0) + 1;
}

export function brainStats() {
  const stats = statsStore() || EMPTY_STATS;
  const top = [...(stats.chosenSeats?.entries?.() || [])]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 25)
    .map(([seat, info]) => ({ seat, count: info.count, tier: info.tier, category: info.category }));
  return {
    pandaDecisions: stats.pandaDecisions,
    jevDecisions: stats.jevDecisions,
    blends: stats.blends,
    fairnessPromotions: stats.fairnessPromotions,
    tierSteered: stats.tierSteered,
    byMode: { ...stats.byMode },
    distinctSeatsChosen: stats.chosenSeats?.size || 0,
    top,
  };
}

export function resetBrainStats() {
  const stats = statsStore();
  if (!stats) return;
  stats.pandaDecisions = 0;
  stats.jevDecisions = 0;
  stats.blends = 0;
  stats.fairnessPromotions = 0;
  stats.tierSteered = 0;
  stats.byMode = { panda: 0, jev: 0, merged: 0 };
  stats.chosenSeats = new Map();
}

function noteChosen(seat, tierInfo) {
  const stats = statsStore() || EMPTY_STATS;
  if (!stats.chosenSeats) stats.chosenSeats = new Map();
  const existing = stats.chosenSeats.get(seat);
  if (existing) existing.count += 1;
  else stats.chosenSeats.set(seat, { count: 1, tier: tierInfo?.tier || "?", category: tierInfo?.subcategory || "?" });
}

// Pick ledger: combo → seat → timestamps of the turns this brain handed it.
// It exists for one reason — the owner wants both "use the best models" and "no
// seat left idle". Merit alone gives the first and never the second, because the
// top two or three seats would carry every agent while 60 others sat unused and
// their quotas expired unused.
const pickLedger = new Map();
const LEDGER_CAP_PER_COMBO = 4096;

function ledgerFor(comboName) {
  if (!comboName) return null;
  let seats = pickLedger.get(comboName);
  if (!seats) {
    seats = new Map();
    pickLedger.set(comboName, seats);
  }
  return seats;
}

function notePick(comboName, seat, windowMs) {
  const seats = ledgerFor(comboName);
  if (!seats || !seat) return;
  const now = Date.now();
  const stamps = seats.get(seat) || [];
  stamps.push(now);
  // Bounded per seat: only the window matters, and a runaway list costs memory.
  seats.set(seat, stamps.filter((at) => now - at <= windowMs).slice(-LEDGER_CAP_PER_COMBO));
}

function pickCount(seats, seat, windowMs) {
  if (!seats) return 0;
  const now = Date.now();
  const stamps = seats.get(seat);
  if (!stamps || stamps.length === 0) return 0;
  return stamps.filter((at) => now - at <= windowMs).length;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function rankDecay(index) {
  return Math.pow(DECAY_BASE, Math.max(0, index));
}

// Panda reports difficulty as a level (number or word). Reduce both to 0…1 so the
// tier term knows whether this is heavy work or bulk work.
const DIFFICULTY_WORDS = new Map([
  ["trivial", 0.1], ["easy", 0.2], ["simple", 0.25], ["moderate", 0.5], ["medium", 0.5],
  ["hard", 0.75], ["complex", 0.8], ["difficult", 0.8], ["expert", 0.95], ["very_hard", 0.95],
]);

function difficultyOf(plan) {
  const raw = plan?.difficulty?.level ?? plan?.difficulty;
  if (raw === null || raw === undefined) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    // Panda's scale is 0…1; anything larger is treated as 0…100.
    return numeric > 1 ? clamp01(numeric / 100) : clamp01(numeric);
  }
  return DIFFICULTY_WORDS.get(String(raw).toLowerCase()) ?? null;
}

/**
 * Create a brain for one request. Panda is called at most once per request (the seat
 * ordering and the blended decision share the result), and Jev likewise.
 *
 * @param {object} options
 * @param {object} options.body            client request body
 * @param {object} options.policy          resolved routing policy
 * @param {object} [options.comboCfg]      per-combo strategy record (routerBrain/routerModel override)
 * @param {string} [options.comboName]
 * @param {object} [options.log]
 */
export function createRouterBrain({ body, policy, comboCfg = {}, comboName = null, log }) {
  const mode = normalizeRouterBrain(comboCfg.routerBrain || policy.routerBrain);
  const weightSum = clamp01(policy.jevWeight) + clamp01(policy.pandaWeight);
  const wJev = weightSum > 0 ? clamp01(policy.jevWeight) : 0.5;
  const wPanda = weightSum > 0 ? clamp01(policy.pandaWeight) : 0.5;
  const wTier = clamp01(policy.tierBias);

  // Settled slots: the merged wait is bounded, so a brain that answers after the
  // deadline is simply not part of this decision (its value is still readable).
  let pandaSlot = { done: false, plan: null };
  let jevSlot = { done: false, result: null };
  let pandaPromise = null;
  let jevPromise = null;
  let tierPromise = null;

  const usesPanda = mode !== "jev" && policy.panda?.enabled !== false;
  const usesJev = mode !== "panda";

  function ensurePanda(items) {
    if (!usesPanda) return Promise.resolve(null);
    if (!pandaPromise) {
      pandaPromise = rankStrings({ items, body, policy, log })
        .then((plan) => {
          pandaSlot = { done: true, plan: plan || null };
          if (plan) bump("pandaDecisions");
          return pandaSlot.plan;
        })
        .catch(() => {
          pandaSlot = { done: true, plan: null };
          return null;
        });
    }
    return pandaPromise;
  }

  function ensureJev(items) {
    if (!usesJev) return Promise.resolve(null);
    if (!jevPromise) {
      jevPromise = resolveSmartChoice({
        body,
        models: items,
        routerModel: comboCfg.routerModel,
        log,
        timeoutMs: policy.jevTimeoutMs,
      })
        .then((result) => {
          jevSlot = { done: true, result: result || null };
          if (result) bump("jevDecisions");
          return jevSlot.result;
        })
        .catch((error) => {
          log?.warn?.("BRAIN", `jev decision failed (${error?.message || error})`);
          jevSlot = { done: true, result: null };
          return null;
        });
    }
    return jevPromise;
  }

  // Class of every seat, from the catalog name when the provider ships one
  // (`qd/qfmodel` is Qwen3.8-Flash). Answers are cached per seat for the request.
  function ensureTiers(items) {
    if (!tierPromise) {
      tierPromise = Promise.all(items.map(async (seat) => {
        const name = await modelNameFor(seat).catch(() => "");
        return [seat, modelTier(seat, name)];
      })).then((pairs) => new Map(pairs))
        .catch(() => new Map());
    }
    return tierPromise;
  }

  // Waits for both brains but never longer than brainTimeoutMs: after that the
  // decision is made from whatever answered. A slow classifier must not delay a
  // generation that could already be running.
  async function bothSettled(items) {
    const deadline = Math.max(0, Number(policy.brainTimeoutMs) || 0);
    const pending = [ensurePanda(items), ensureJev(items), ensureTiers(items)];
    if (deadline > 0) {
      await Promise.race([...pending, new Promise((resolve) => setTimeout(resolve, deadline))]);
    } else {
      await Promise.all(pending);
    }
    return {
      plan: pandaSlot.done ? pandaSlot.plan : null,
      jev: jevSlot.done ? jevSlot.result : null,
      tiers: await tierPromise,
    };
  }

  function pandaScoreFor(seat, plan) {
    if (!plan) return null;
    const entry = (plan.ranked || []).find((item) => item.key === seat);
    if (entry && Number.isFinite(Number(entry.p))) return clamp01(entry.p);
    const index = (plan.items || []).indexOf(seat);
    if (index === -1) return UNRANKED_PANDA;
    return rankDecay(index);
  }

  function jevScoreFor(seat, jev) {
    if (!jev) return null;
    if (jev.choice === seat) return 1;
    const probabilities = jev.probabilities;
    if (probabilities && Number.isFinite(Number(probabilities[seat]))) {
      // System One probabilities are not normalised across the whole pool, so scale
      // by the largest one: the winner reaches 1 and the rest keep the ratio.
      const maxP = Math.max(...Object.values(probabilities).map((v) => Number(v) || 0), 1);
      return clamp01(Number(probabilities[seat]) / maxP);
    }
    return 0;
  }

  // Hard task → the heavy end of the fleet; easy task → the flash pool. The class is
  // only a nudge (tierBias), never a veto: Panda's success probability still decides
  // whether a seat can do this job at all.
  function tierScoreFor(seat, tiers, difficulty) {
    if (!wTier || !tiers || tiers.size === 0) return null;
    const info = tiers.get(seat);
    if (!info) return null;
    if (difficulty === null) return info.tier === TIER_FLASH ? 0.4 : 0.6;
    const fit = info.tier === TIER_FLASH ? 1 - difficulty : difficulty;
    return clamp01(fit);
  }

  function blend(items, plan, jev, tiers, difficulty) {
    const scored = items.map((seat, originalIndex) => {
      const p = pandaScoreFor(seat, plan);
      const j = jevScoreFor(seat, jev);
      const t = tierScoreFor(seat, tiers, difficulty);
      // A brain that did not answer contributes nothing rather than dragging the seat
      // down with a zero, so the weights re-normalise over what is present.
      const parts = [];
      if (p !== null) parts.push([wPanda, p]);
      if (j !== null) parts.push([wJev, j]);
      if (t !== null) parts.push([wTier, t]);
      const weightSum2 = parts.reduce((sum, [w]) => sum + w, 0);
      const score = weightSum2 > 0
        ? parts.reduce((sum, [w, v]) => sum + w * v, 0) / weightSum2
        : 0;
      return { seat, score, panda: p, jev: j, tier: t, info: tiers?.get(seat) || null, originalIndex };
    });

    scored.sort((a, b) => {
      // A seat another agent just saw refuse is tried after every seat that has not
      // failed recently. Without this, each of the eight concurrent sessions walks the
      // same dead seat from the top — the "sab models par baar-baar" hammering — and
      // the shared breaker's memory is thrown away on every new request.
      const aDeg = isDegraded(a.seat) ? 1 : 0;
      const bDeg = isDegraded(b.seat) ? 1 : 0;
      if (aDeg !== bDeg) return aDeg - bDeg;
      if (b.score !== a.score) return b.score - a.score;
      // Ties: the heavy class first (the owner wants the best models used), then
      // Panda's order, then the owner's own order.
      const rankGap = (a.info?.rank ?? 0) - (b.info?.rank ?? 0);
      if (rankGap !== 0) return rankGap;
      const pandaOrder = (plan?.items || []).indexOf(a.seat) - (plan?.items || []).indexOf(b.seat);
      if (Number.isFinite(pandaOrder) && pandaOrder !== 0 && (plan?.items || []).length) return pandaOrder;
      return a.originalIndex - b.originalIndex;
    });

    return scored;
  }

  // Agreement is the strongest signal either brain can give: both pointing at the same
  // seat means "send it now, no waiting". A near-tie between two disagreeing brains
  // stays under the switch threshold so the warm prompt-cache seat is kept.
  function decisionConfidence(scored, jev, plan) {
    const winner = scored[0];
    if (mode === "jev") return jev?.confidence ?? null;
    if (!jev && !plan) return null;

    if (jev?.choice && winner?.seat === jev.choice) {
      const pandaAgrees = !plan || plan.items?.[0] === jev.choice;
      if (pandaAgrees) return 1;
    }
    if (jev) return clamp01(jev.confidence ?? 0.9);

    // Panda only: its calibrated success probability for the winning seat.
    const p = winner?.panda;
    if (Number.isFinite(p)) return clamp01(p);
    return plan ? 0.9 : null;
  }

  // Fairness pass: with the configured probability, a seat that has not been picked at
  // all inside the window gets promoted over the merit winner — the best-merit starving
  // seat, so rotation never drops into the weak tail. This is what turns "koi model
  // khaali nahi bachna chahiye" into an actual coverage counter, while merit still
  // decides the other turns.
  function promoteStarving(order) {
    const windowMs = Math.max(1000, Number(policy.seatFairnessWindowMs) || 900000);
    const fairness = clamp01(policy.seatFairness);
    if (!fairness || !comboName || order.length < 2) return { order, promoted: null, windowMs };
    const seats = ledgerFor(comboName);
    const starving = order.filter((seat) => pickCount(seats, seat, windowMs) === 0);
    if (starving.length === 0) return { order, promoted: null, windowMs };
    // Coverage-first: the chance of taking a turn for an unseen seat grows with how
    // much of the fleet is still unseen, so a 105-seat combo gets its first pass over
    // every model quickly, and once nothing is starving the decision is pure merit +
    // class again. `seatFairness` is the floor of that chance (merit bias).
    const unpickedShare = starving.length / order.length;
    const chance = Math.min(0.95, fairness + (1 - fairness) * unpickedShare);
    if (Math.random() >= chance) return { order, promoted: null, windowMs };
    // `order` is merit-sorted, so the first starving seat is the strongest of them.
    const promoted = starving[0];
    bump("fairnessPromotions");
    return { order: [promoted, ...order.filter((seat) => seat !== promoted)], promoted, windowMs };
  }

  // Jev-only ordering, used both by choose() (when the combo runs the smart strategy)
  // and by preOrder() (when it runs a plain rotation, where nothing would otherwise
  // ask Jev and "Jev only" would silently degrade to "no brain at all").
  async function decideJevOrder(items) {
    const jev = await ensureJev(items);
    if (!jev) return null;
    const tiers = await ensureTiers(items);
    const jevOrder = [jev.choice, ...items.filter((seat) => seat !== jev.choice)];
    const { order, promoted, windowMs } = promoteStarving(jevOrder);
    notePick(comboName, order[0], windowMs);
    noteChosen(order[0], tiers.get(order[0]));
    bumpMode("jev");
    if (promoted) log?.info?.("BRAIN", `jev on "${comboName || "?"}" → ${order[0]} [fairness: unpicked seat promoted over ${jev.choice}]`);
    return {
      ...jev,
      choice: order[0],
      brain: "jev",
      order,
      brains: { jev: jev.choice, panda: null, agreement: false, fairnessPick: promoted || null },
    };
  }

  return {
    mode,
    weights: { jev: wJev, panda: wPanda, tier: wTier },

    /**
     * Seat ordering to hand the combo dispatcher, before any blended decision.
     *   jev     → owner's order untouched; Jev reorders inside the dispatcher.
     *   panda   → Panda's ranking.
     *   merged  → under the "smart" strategy the blend happens in `choose()`, which
     *             also owns the session-stickiness rules, so pre-ordering only puts
     *             Panda's ranking down as the tail. Under a plain rotation strategy
     *             nothing calls `choose()`, so the blend is computed right here —
     *             otherwise "merged" would silently degrade to Panda-only.
     */
    async preOrder(items, strategy = "fallback") {
      if (!Array.isArray(items) || items.length <= 1) return { items, plan: null };
      if (mode === "jev") {
        if (strategy === "smart") return { items, plan: null };
        const decision = await decideJevOrder(items);
        return { items: decision?.order?.length ? decision.order : items, plan: null };
      }

      const plan = await ensurePanda(items);
      if (mode === "merged" && strategy !== "smart") {
        const { plan: settledPlan, jev, tiers } = await bothSettled(items);
        const scored = blend(items, settledPlan, jev, tiers, difficultyOf(settledPlan));
        const { order, promoted, windowMs } = promoteStarving(scored.map((entry) => entry.seat));
        notePick(comboName, order[0], windowMs);
        noteChosen(order[0], scored.find((entry) => entry.seat === order[0])?.info);
        bump("blends");
        if (promoted) log?.info?.("BRAIN", `merged on "${comboName || "?"}" → ${promoted} [fairness: unpicked seat promoted]`);
        return { items: order, plan: settledPlan || plan };
      }

      const order = plan?.items?.length ? plan.items : items;
      if (mode === "panda") {
        // Nobody else orders this combo, so the coverage counter lives right here.
        const tiers = await ensureTiers(items);
        const { order: fair, promoted, windowMs } = promoteStarving(order);
        notePick(comboName, fair[0], windowMs);
        noteChosen(fair[0], tiers.get(fair[0]));
        bumpMode("panda");
        if (promoted) log?.info?.("BRAIN", `panda on "${comboName || "?"}" → ${promoted} [fairness: unpicked seat promoted]`);
        return { items: fair, plan };
      }
      return { items: order, plan };
    },

    /**
     * Drop-in for handleComboChat's `resolveSmartChoice`. Returns the same shape
     * (choice / confidence / probabilities) so the existing stickiness and threshold
     * rules apply unchanged — only now the numbers come from both brains, the model's
     * class and the fairness counter.
     */
    async choose(items) {
      if (!Array.isArray(items) || items.length <= 1) return null;

      if (mode === "jev") {
        return await decideJevOrder(items);
      }

      const { plan, jev, tiers } = await bothSettled(items);
      if (!plan && !jev && tiers.size === 0) return null;

      const difficulty = difficultyOf(plan);
      const scored = blend(items, plan, jev, tiers, difficulty);
      const probabilities = {};
      for (const entry of scored) probabilities[entry.seat] = Number(entry.score.toFixed(4));

      const { order, promoted, windowMs } = promoteStarving(scored.map((entry) => entry.seat));

      const winnerSeat = order[0];
      probabilities[winnerSeat] = Math.max(1, (probabilities[winnerSeat] || 0) + 1);
      notePick(comboName, winnerSeat, windowMs);

      const winner = scored.find((entry) => entry.seat === winnerSeat) || scored[0];
      const confidence = decisionConfidence(scored, jev, plan);
      bump("blends");
      bumpMode(mode);
      noteChosen(winnerSeat, winner.info);
      if (difficulty !== null && wTier > 0 && winner.tier !== null) bump("tierSteered");

      log?.info?.("BRAIN", `${mode} on "${comboName || "?"}" → ${winnerSeat}` +
        ` [${winner.info?.subcategory || "unclassified"}]` +
        (promoted ? " [fairness: unpicked seat promoted over merit winner]" : "") +
        ` (panda=${winner.panda === null ? "n/a" : winner.panda.toFixed(3)},` +
        ` jev=${winner.jev === null ? "n/a" : winner.jev.toFixed(3)},` +
        ` tier=${winner.tier === null ? "n/a" : winner.tier.toFixed(2)},` +
        ` difficulty=${difficulty === null ? "n/a" : difficulty.toFixed(2)},` +
        ` jevPick=${jev?.choice || "n/a"}, pandaPick=${plan?.items?.[0] || "n/a"},` +
        ` conf=${confidence === null ? "n/a" : Number(confidence).toFixed(2)})`);

      return {
        choice: winnerSeat,
        confidence,
        probabilities,
        brain: mode,
        order,
        // Kept for logging/tests: what each brain wanted on its own.
        brains: {
          jev: jev?.choice || null,
          panda: plan?.items?.[0] || null,
          agreement: !!(jev?.choice && plan?.items?.[0] && jev.choice === plan.items[0]),
          fairnessPick: promoted || null,
          tier: winner.info?.tier || null,
          category: winner.info?.subcategory || null,
          difficulty,
        },
        panda: plan ? { traceId: plan.traceId, request: plan.request, response: plan.response } : null,
      };
    },

    /** Panda's trace handle for the outcome report, whatever the blend did with it. */
    get pandaTrace() {
      return pandaSlot.plan?.traceId || null;
    },
    get pandaPlan() {
      return pandaSlot.plan || null;
    },
    get jevResult() {
      return jevSlot.result || null;
    },
  };
}
