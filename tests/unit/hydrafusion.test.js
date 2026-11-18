import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";

import { handleHydraFusionChat } from "../../open-sse/services/combo.js";
import {
  HYDRAFUSION_EFFORTS,
  defaultHydraPattern,
  hydraFamilyOf,
  planHydraRun,
  rankHydraSeats,
  resolveHydraEffort,
  resolveHydraPattern,
} from "../../open-sse/config/hydrafusion.js";
import { buildHydraStateBlock, injectHydraState, loadHydraState, saveHydraState } from "../../open-sse/services/hydrafusionState.js";
import { isSeatHealthy, markSeatFailure, resetSeatHealth } from "../../open-sse/services/seatHealth.js";
import { normalizeStrategy } from "../../src/lib/routing/strategies.js";

const log = { info: () => {}, warn: () => {}, debug: () => {} };

beforeAll(() => {
  vi.stubEnv("ORIGINROUTER_DATA_DIR", path.join(os.tmpdir(), `originrouter-hydra-test-${process.pid}`));
});

function okResponse(content) {
  const json = { choices: [{ message: { role: "assistant", content } }] };
  const make = () => ({ ok: true, status: 200, clone: make, json: async () => json, text: async () => "" });
  return make();
}

function badResponse(status, text = "") {
  const make = () => ({
    ok: false,
    status,
    clone: make,
    json: async () => ({ error: { message: text } }),
    text: async () => text,
  });
  return make();
}

beforeEach(() => {
  resetSeatHealth();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("HydraFusion effort ladder", () => {
  it("exposes the six requested tiers in order", () => {
    expect(HYDRAFUSION_EFFORTS.map((t) => t.id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("is monotonic: deeper tiers never use fewer seats or auditors", () => {
    for (let i = 1; i < HYDRAFUSION_EFFORTS.length; i += 1) {
      const previous = HYDRAFUSION_EFFORTS[i - 1];
      const current = HYDRAFUSION_EFFORTS[i];
      expect(current.panel).toBeGreaterThanOrEqual(previous.panel);
      expect(current.critics).toBeGreaterThanOrEqual(previous.critics);
      expect(current.hardTimeoutMs).toBeGreaterThanOrEqual(previous.hardTimeoutMs);
    }
  });

  it("resolves synonyms and unknown values without throwing", () => {
    expect(resolveHydraEffort("ultracode").id).toBe("ultra");
    expect(resolveHydraEffort("EXTRA").id).toBe("xhigh");
    // minimal / minimum / light / low are four spellings of one level.
    for (const alias of ["minimal", "minimum", "light", "low", "MINIMAL"]) {
      expect(resolveHydraEffort(alias).id).toBe("low");
    }
    // There is no "off" stop anymore; unknown values fall back to the default.
    expect(resolveHydraEffort("off").id).toBe("high");
    expect(resolveHydraEffort("nonsense").id).toBe("high");
  });

  it("auto picks Cascade at the bottom and Critique at the top", () => {
    expect(defaultHydraPattern("minimal")).toBe("cascade");
    expect(defaultHydraPattern("light")).toBe("cascade");
    expect(defaultHydraPattern("low")).toBe("cascade");
    expect(defaultHydraPattern("medium")).toBe("cascade");
    expect(defaultHydraPattern("high")).toBe("critique");
    expect(defaultHydraPattern("ultra")).toBe("critique");
    expect(resolveHydraPattern("auto", "max")).toBe("critique");
    expect(resolveHydraPattern("single", "ultra")).toBe("single");
  });

  it("plans independent auditors before reusing the judge", () => {
    const plan = planHydraRun({
      models: ["p/a", "p/b", "p/c", "p/d", "p/judge"],
      judgeModel: "p/judge",
      effort: "xhigh",
      pattern: "critique",
    });
    expect(plan.panel).toEqual(["p/a", "p/b", "p/c", "p/d"]);
    expect(plan.critics).toEqual(["p/judge", "p/a"]);
    expect(plan.pattern).toBe("critique");
  });

  it("rotates sampled seats across the pool so every model gets used", () => {
    const models = ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f"];
    const firstSeats = new Set();
    for (let i = 0; i < 24; i += 1) {
      const plan = planHydraRun({
        models,
        judgeModel: "p/judge",
        effort: "high",
        pattern: "critique",
        seed: `task-${i}`,
      });
      expect(plan.panel).toHaveLength(6);
      firstSeats.add(plan.panel[0]);
    }
    expect(firstSeats.size).toBeGreaterThan(1);
    expect([...firstSeats].every((m) => models.includes(m))).toBe(true);
  });

  it("keeps Fusion working as an alias rather than a dead strategy", () => {
    expect(normalizeStrategy("fusion")).toBe("hydrafusion");
  });
});

describe("HydraFusion handler", () => {
  it("Single keeps the client's stream flag and tools, and injects the tier's effort", async () => {
    const seen = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      seen.push({ body, model });
      return okResponse("solo");
    });

    await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "hi" }], stream: true, tools: [{ name: "x" }] },
      models: ["p/a", "p/judge"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      effort: "minimal",
      pattern: "single",
      category: "general",
    });

    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(seen[0].model).toBe("p/judge");
    expect(seen[0].body.stream).toBe(true);
    expect(seen[0].body.tools).toEqual([{ name: "x" }]);
    expect(seen[0].body.reasoning_effort).toBe("low");
    expect(seen[0].body.messages.at(-1).content).toBe("hi");
  });

  it("Critique fans out, audits the drafts, then streams one judge answer", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (body, model, isPanel) => {
      calls.push({ body, model, isPanel });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleHydraFusionChat({
      body: {
        messages: [{ role: "user", content: "Q" }],
        stream: true,
        stream_options: { include_usage: true },
      },
      models: ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f", "p/g", "p/judge"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      effort: "high",
      pattern: "critique",
      seed: "",
      category: "general",
    });

    // 6 panel + 1 auditor + 1 final judge.
    expect(handleSingleModel).toHaveBeenCalledTimes(8);
    const panels = calls.filter((c) => ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f"].includes(c.model));
    expect(panels).toHaveLength(6);
    for (const call of panels) {
      expect(call.body.stream).toBe(false);
      expect(call.body.tools).toBeUndefined();
      expect(call.body.stream_options).toBeUndefined();
      expect(call.body.reasoning_effort).toBe("high");
      expect(call.isPanel).toBe(true);
    }

    const audit = calls.find((c) => c.model === "p/g");
    expect(audit).toBeTruthy();
    expect(audit.body.stream).toBe(false);
    expect(audit.body.messages.at(-1).content).toContain("AUDITOR");
    expect(audit.body.messages.at(-1).content).toContain("ans-p/a");
    expect(audit.body.messages.at(-1).content).toContain("ans-p/c");

    const final = calls.find((c) => c.model === "p/judge");
    expect(final.body.stream).toBe(true);
    expect(final.body.tools).toBeUndefined();
    expect(final.body.messages.at(-1).content).toContain("AUDITOR FINDINGS");
    expect(final.body.messages.at(-1).content).toContain("final JUDGE");
    expect(res.ok).toBe(true);
  });

  it("Cascade feeds each stage the previous complete draft", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      calls.push({ body, model });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`draft-${model}`);
    });

    await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/a", "p/b", "p/judge"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      effort: "medium",
      pattern: "cascade",
      seed: "",
      category: "general",
    });

    // stage a, stage b, final judge.
    expect(handleSingleModel).toHaveBeenCalledTimes(3);
    const stageA = calls[0];
    const stageB = calls[1];
    expect(stageA.body.stream).toBe(false);
    expect(stageB.body.stream).toBe(false);
    expect(stageB.body.messages.at(-1).content).toContain("draft-p/a");
    const final = calls[2];
    expect(final.body.stream).toBe(true);
    expect(final.body.messages.at(-1).content).toContain("draft-p/a");
    expect(final.body.messages.at(-1).content).toContain("draft-p/b");
  });

  it("retries a seat once without reasoning_effort when the provider rejects the tier", async () => {
    const attempts = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      attempts.push({ model, effort: body.reasoning_effort });
      if (model === "p/a" && body.reasoning_effort) {
        return badResponse(400, "unknown parameter: reasoning_effort");
      }
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    const res = await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/a", "p/judge"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      effort: "high",
      pattern: "critique",
      seed: "",
      category: "general",
    });

    expect(res.ok).toBe(true);
    const aAttempts = attempts.filter((a) => a.model === "p/a");
    expect(aAttempts).toHaveLength(2);
    expect(aAttempts[0].effort).toBe("high");
    expect(aAttempts[1].effort).toBeUndefined();
  });
});

describe("HydraFusion per-request conductor", () => {
  it("interleaves families so no panel is six aliases of one model", () => {
    const models = [
      "or/deepseek/deepseek-v4-pro",
      "or/~deepseek/deepseek-pro-latest",
      "tt/DeepSeek-V4.1-Flash-1017",
      "or/z-ai/glm-5.3-flash",
      "or/qwen/qwen3.8-omni-flash",
      "oc/minimax-m3.1-flash-free",
    ];
    const ranked = rankHydraSeats(models, "code", "seed-1");
    const families = ranked.slice(0, 5).map(hydraFamilyOf);
    expect(new Set(families).size).toBe(5);
    expect(hydraFamilyOf(ranked[0])).toBe("deepseek-pro");
    expect(ranked).toHaveLength(models.length);
    expect([...ranked].sort()).toEqual([...models].sort());
  });

  it("rotates provider aliases inside a family without losing diversity", () => {
    const models = ["or/deepseek/deepseek-v4-pro", "or/~deepseek/deepseek-pro-latest", "glm-5.3"];
    const firsts = new Set();
    for (let i = 0; i < 16; i += 1) {
      firsts.add(rankHydraSeats(models, "code", `task-${i}`)[0]);
    }
    expect(firsts.size).toBeGreaterThan(1);
    expect([...firsts].every((m) => models.includes(m))).toBe(true);
  });

  it("uses the conductor's category and keeps that seat out of the panel", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      calls.push({ body, model });
      if (body.max_tokens === 80) return okResponse('{"category":"code"}');
      if (model === "or/deepseek/deepseek-v4-pro") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });
    const lines = [];
    const capture = { info: (_, line) => lines.push(String(line)), warn: () => {}, debug: () => {} };

    const res = await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "fix this python traceback" }], stream: true },
      models: ["or/deepseek/deepseek-v4-pro", "glm-5.3", "oc/minimax-m3.1-flash-free"],
      handleSingleModel,
      log: capture,
      judgeModel: "or/deepseek/deepseek-v4-pro",
      effort: "high",
      pattern: "critique",
      seed: "",
    });

    expect(res.ok).toBe(true);
    expect(lines.some((line) => line.includes("category=code"))).toBe(true);
    const conductorCall = calls.find((c) => c.body.max_tokens === 80);
    expect(conductorCall).toBeTruthy();
    expect(conductorCall.body.messages[0].content).toContain("Classify");
  });

  it("puts the frontier seat in front of its free aliases", () => {
    const frontier = "openrouter/moonshotai/kimi-k3.1-pro";
    const abliterated = "numes/uniboshi/kimi-k3-abliterated-v1";
    const ranked = rankHydraSeats(
      [abliterated, "or/deepseek/deepseek-v4-pro", "or/glm-5.3-flash", frontier],
      "code",
    );
    expect(hydraFamilyOf(frontier)).toBe("kimi-pro");
    expect(hydraFamilyOf(abliterated)).toBe("uncensored");
    expect(ranked[0]).toBe(frontier);
  });

  it("falls back to the heuristic when the conductor cannot classify", async () => {
    const handleSingleModel = vi.fn(async (body, model) => {
      if (body.max_tokens === 80) return okResponse("I am not sure, maybe a poem?");
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });
    const lines = [];
    const capture = { info: (_, line) => lines.push(String(line)), warn: () => {}, debug: () => {} };

    const res = await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "write a haiku about rain" }], stream: true },
      models: ["p/a", "p/judge"],
      handleSingleModel,
      log: capture,
      judgeModel: "p/judge",
      effort: "medium",
      pattern: "critique",
      seed: "",
    });

    expect(res.ok).toBe(true);
    expect(lines.some((line) => line.includes("conductor unavailable — heuristic=writing") || line.includes("category=writing"))).toBe(true);
  });
});

describe("HydraFusion seat health and sentinels", () => {
  it("drops the router's no-provider notice instead of treating it as a draft", async () => {
    const calls = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      calls.push({ body, model });
      if (model === "p/judge") return okResponse("FINAL");
      if (model === "p/b") {
        return okResponse("OriginRouter could not reach any provider for this request just now. Send it again and it will be routed...");
      }
      return okResponse(`ans-${model}`);
    });

    const res = await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f", "p/g", "p/judge"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      effort: "high",
      pattern: "critique",
      seed: "",
      category: "general",
    });

    expect(res.ok).toBe(true);
    expect(isSeatHealthy("p/b")).toBe(false);
    const final = calls.find((c) => c.model === "p/judge" && c.body.stream === true);
    expect(final.body.messages.at(-1).content).not.toContain("could not reach any provider");
  });

  it("skips a cooling seat on the next request", async () => {
    markSeatFailure("p/z", "timeout");
    const called = [];
    const handleSingleModel = vi.fn(async (body, model) => {
      called.push({ model, body });
      if (model === "p/judge") return okResponse("FINAL");
      return okResponse(`ans-${model}`);
    });

    await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: true },
      models: ["p/a", "p/b", "p/c", "p/d", "p/z", "p/judge"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      effort: "high",
      pattern: "critique",
      seed: "",
      category: "general",
    });

    expect(called.some((c) => c.model === "p/z")).toBe(false);
  });

  it("never leaves the client without an answer when the judge dies", async () => {
    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "p/judge") throw new Error("judge exploded");
      return okResponse(`draft-${model}-with-substance`);
    });

    const res = await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "Q" }], stream: false },
      models: ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f", "p/g", "p/judge"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      effort: "high",
      pattern: "critique",
      seed: "",
      category: "general",
    });

    expect(res.ok).toBe(true);
    const json = await res.json();
    expect(json.choices[0].message.content).toContain("draft-");
  });

  it("treats a tool-bearing request as an agent turn and keeps tools on one seat", async () => {
    const handleSingleModel = vi.fn(async () => okResponse("done"));
    const tools = [{ type: "function", function: { name: "Read", parameters: { type: "object" } } }];

    await handleHydraFusionChat({
      body: { messages: [{ role: "user", content: "read the file" }], tools, stream: true },
      models: ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f", "p/g", "p/judge"],
      handleSingleModel,
      log,
      judgeModel: "p/judge",
      effort: "high",
      pattern: "critique",
      seed: "",
      category: "general",
    });

    // One actor, not a panel: the debate stages would strip the tools.
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    const [sentBody, sentModel] = handleSingleModel.mock.calls[0];
    expect(sentModel).toBe("p/a");
    expect(sentBody.tools).toEqual(tools);
    expect(sentBody.stream).toBe(true);
  });

  it("answers a /v1/messages caller in Anthropic shape when the judge dies", async () => {
    const handleSingleModel = vi.fn(async (body, model) => {
      if (model === "p/judge") throw new Error("judge exploded");
      return okResponse(`draft-${model}-with-substance`);
    });
    const call = (stream) =>
      handleHydraFusionChat({
        body: { messages: [{ role: "user", content: "Q" }], stream },
        models: ["p/a", "p/b", "p/c", "p/d", "p/e", "p/f", "p/g", "p/judge"],
        handleSingleModel,
        log,
        judgeModel: "p/judge",
        effort: "high",
        pattern: "critique",
        seed: "",
        category: "general",
        format: "claude",
      });

    const json = await (await call(false)).json();
    expect(json.type).toBe("message");
    expect(json.role).toBe("assistant");
    expect(json.content[0].text).toContain("draft-");
    expect(json.choices).toBeUndefined();

    const sse = await (await call(true)).text();
    expect(sse).toContain("event: message_start");
    expect(sse).toContain("event: content_block_delta");
    expect(sse).toContain("event: message_stop");
    expect(sse).not.toContain("chat.completion");
    expect(sse).not.toContain("[DONE]");
  });
});

describe("HydraFusion reasoning state", () => {
  it("injects a compact carry-forward block into the system prompt", () => {
    const state = {
      v: 1,
      runs: 3,
      effort: "max",
      pattern: "critique",
      relay: {
        lastUser: "fix the parser",
        lastDraft: "the parser loop skips the last token",
        critique: "off-by-one at the boundary",
        panel: [{ model: "p/a", excerpt: "check EOF handling" }],
      },
    };

    const block = buildHydraStateBlock(state);
    expect(block).toContain("HYDRAFUSION REASONING STATE");
    expect(block).toContain("run 3");
    expect(block).toContain("fix the parser");

    const body = injectHydraState(
      { messages: [{ role: "system", content: "be terse" }, { role: "user", content: "go" }] },
      state,
    );
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("be terse");
    expect(body.messages[0].content).toContain("HYDRAFUSION REASONING STATE");
    expect(body.messages[1].content).toBe("go");
  });

  it("returns the original body when there is no state", () => {
    const body = { messages: [{ role: "user", content: "go" }] };
    expect(injectHydraState(body, null)).toBe(body);
  });

  it("carries state across turns of one session even when the last user text changes", () => {
    const base = { comboName: "combo-a", sessionId: "session-1", anchorText: "first question" };
    saveHydraState({ ...base, userText: "first question", effort: "high", pattern: "critique" });
    const first = loadHydraState({ ...base, userText: "first question" });
    expect(first.runs).toBe(1);

    saveHydraState({
      ...base,
      userText: "second question",
      effort: "max",
      pattern: "critique",
      previous: first,
      relay: { lastDraft: "answer two", critique: "no findings", panel: [] },
    });
    const second = loadHydraState({ ...base, userText: "third question" });
    expect(second.runs).toBe(2);
    expect(second.effort).toBe("max");
    expect(second.relay.lastDraft).toBe("answer two");
  });
});
