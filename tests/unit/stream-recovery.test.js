// Stream recovery — DeliveredPrefix tracker + ContinuationSeed tests.
import { describe, it, expect } from "vitest";
import {
  createDeliveryTracker,
  buildContinuation,
  getSnapshot,
  seedStats,
} from "../../open-sse/services/streamRecovery.js";

describe("delivered prefix tracker", () => {
  it("accumulates text + reasoning deltas and clips to the retention cap", () => {
    const t = createDeliveryTracker({ model: "m" });
    t.feedDelta({ content: "Hello " });
    t.feedDelta({ content: "world", reasoning_content: "thinking..." });
    const snap = t.snapshot();
    expect(snap.text).toBe("Hello world");
    expect(snap.thinking).toBe("thinking...");
    expect(snap.canHandoff).toBe(true);
  });

  it("tracks tool-call argument fragments by index", () => {
    const t = createDeliveryTracker({});
    t.feedDelta({ tool_calls: [{ index: 0, id: "c1", function: { name: "grep", arguments: '{"pat' } }] });
    t.feedDelta({ tool_calls: [{ index: 0, function: { arguments: 'tern":"x"}' } }] });
    const snap = t.snapshot();
    expect(snap.toolFragments).toHaveLength(1);
    expect(snap.toolFragments[0]).toMatchObject({ id: "c1", name: "grep", args: '{"pattern":"x"}' });
  });

  it("marks unsafe when fragments exceed the cap (no blind handoff)", () => {
    const t = createDeliveryTracker({});
    for (let i = 0; i < 25; i++) t.feedDelta({ tool_calls: [{ index: i, id: `c${i}`, function: { name: "f", arguments: "" } }] });
    expect(t.snapshot().canHandoff).toBe(false);
  });

  it("commit drops the seed", () => {
    const t = createDeliveryTracker({});
    const before = seedStats().live;
    t.commit();
    expect(seedStats().live).toBe(before - 1);
  });
});

describe("continuation seed", () => {
  it("rebuilds a continuing request with the delivered text as an assistant turn", () => {
    const t = createDeliveryTracker({});
    t.feedDelta({ content: "The parser bug is in" });
    const body = { messages: [{ role: "user", content: "find the bug" }] };
    const cont = buildContinuation({ body, snapshot: t.snapshot() });
    expect(cont.applied).toBe(true);
    const msgs = cont.body.messages;
    expect(msgs[msgs.length - 2].role).toBe("assistant");
    expect(msgs[msgs.length - 2].content).toBe("The parser bug is in");
    expect(msgs[msgs.length - 1].role).toBe("user");
    expect(msgs[msgs.length - 1].content).toContain("Continue");
  });

  it("returns null when nothing deliverable", () => {
    const t = createDeliveryTracker({});
    const body = { messages: [{ role: "user", content: "hi" }] };
    expect(buildContinuation({ body, snapshot: t.snapshot() })).toBeNull();
    expect(buildContinuation({ body, snapshot: null })).toBeNull();
  });

  it("getSnapshot reads live seeds by id", () => {
    const t = createDeliveryTracker({});
    t.feedDelta({ content: "abc" });
    expect(getSnapshot(t.seedId).text).toBe("abc");
    expect(getSnapshot("missing")).toBeNull();
  });
});
