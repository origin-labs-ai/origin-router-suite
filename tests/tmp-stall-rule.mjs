// The stall rule, as an executable contract (plain node, no vitest):
//   node tests/tmp-stall-rule.mjs
//
// What must hold, per the owner:
//   * a member that has sent NO frame is replaceable  (nothing reached the client)
//   * a member that has sent ANY frame is never cut   (cutting truncates an answer)
//   * keepalive comments do not count as a frame      (queued lanes must not hang us)
//   * an answer that completed is never re-requested  (no duplicate prompt)
import assert from "node:assert/strict";
import { peekStreamForContent, reconstructStream } from "../open-sse/services/emptyFailover.js";

const DEADLINE = 250;
const checks = [];
async function check(name, fn) {
  try {
    await fn();
    checks.push(`PASS  ${name}`);
  } catch (error) {
    checks.push(`FAIL  ${name}\n        ${String(error.message).split("\n")[0]}`);
  }
}

const encoder = new TextEncoder();
// A stream that emits the given frames with a gap between them, and optionally
// stays open forever (a live but silent upstream).
function streamOf(frames, { holdOpen = true, tail = null } = {}) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index < frames.length) {
        await new Promise((r) => setTimeout(r, 20));
        controller.enqueue(encoder.encode(frames[index]));
        index += 1;
        return;
      }
      if (tail) { controller.enqueue(encoder.encode(tail)); tail = null; return; }
      if (holdOpen) return;           // stay open, send nothing: the queued-lane case
      controller.close();
    },
  });
}

const CONTENT_FRAME = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n';
const THINKING_FRAME = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}\n\n';
const KEEPALIVE_ONLY = ": OPENROUTER PROCESSING\n\n: OPENROUTER PROCESSING\n\n";

async function peek(frames, opts) {
  const body = streamOf(frames, opts);
  const peeked = await peekStreamForContent(body, { deadlineMs: DEADLINE });
  // A held-open test stream has nothing left to read; release the lock so the
  // process can exit cleanly.
  body.cancel?.().catch(() => {});
  return peeked;
}

await check("silent lane: deadline fires and is reported as NO frame (replaceable)", async () => {
  const peeked = await peek([], { holdOpen: true });
  assert.equal(peeked.outcome, "content", "fail-open so the caller decides");
  assert.equal(peeked.timedOut, true);
  assert.equal(peeked.sawFrame, false, "a lane that sent nothing must be marked frameless");
});

await check("keepalive comments are not a frame (a queued lane is still replaceable)", async () => {
  const peeked = await peek([KEEPALIVE_ONLY], { holdOpen: true });
  assert.equal(peeked.timedOut, true);
  assert.equal(peeked.sawFrame, false, "comments must never be mistaken for an answer starting");
});

await check("a stream that sent a thinking frame is alive: must NOT be marked frameless", async () => {
  const peeked = await peek([THINKING_FRAME], { holdOpen: true });
  assert.equal(peeked.timedOut, true, "still no content, so the deadline does fire");
  assert.equal(peeked.sawFrame, true, "cutting this one would truncate reasoning already delivered");
});

await check("a content frame ends the peek immediately, no timeout, no second request", async () => {
  const started = Date.now();
  const peeked = await peek([CONTENT_FRAME], { holdOpen: true });
  assert.equal(peeked.outcome, "content");
  assert.equal(peeked.timedOut, false);
  assert.ok(Date.now() - started < DEADLINE, "content must commit before the deadline");
});

await check("a stream that ends with nothing is 'empty' (existing failover path, not a timeout)", async () => {
  const peeked = await peek([], { holdOpen: false });
  assert.equal(peeked.outcome, "empty");
  assert.equal(peeked.timedOut, false);
});

await check("replay keeps every byte the peek already read (no dropped chunk after deadline)", async () => {
  const body = streamOf([THINKING_FRAME], { holdOpen: false });
  const peeked = await peekStreamForContent(body, { deadlineMs: DEADLINE });
  const replay = reconstructStream(peeked.head, peeked.reader, peeked.pendingRead);
  const text = await new Response(replay).text();
  assert.ok(text.includes("thinking_delta"), `replayed text lost the frame: ${text.slice(0, 120)}`);
});

console.log(checks.join("\n"));
const failed = checks.filter((c) => c.startsWith("FAIL")).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
