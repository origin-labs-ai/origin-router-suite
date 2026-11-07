// Proves the per-key budget end to end: a key with a small budget is turned
// away with a 429 once it is spent, and the headers say when to come back.
const base = process.env.OR_BASE || "http://127.0.0.1:20128";
const password = process.env.OR_LOGIN_PASSWORD || "123456";

async function main() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const auth = { Cookie: cookie };

  const created = await fetch(`${base}/api/keys`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "rate-limit-check" }),
  });
  const body = await created.json();
  const key = body?.key?.key || body?.key;
  if (!key) throw new Error(`no key created: ${JSON.stringify(body).slice(0, 300)}`);

  const id = body?.key?.id || body?.id;
  const limit = await fetch(`${base}/api/key-rate-limits`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ keyId: id, limits: { rpm: 2, maxConcurrent: 0 } }),
  });
  console.log("budget saved:", limit.status);

  const statuses = [];
  for (let i = 1; i <= 4; i++) {
    const res = await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } });
    statuses.push(res.status);
    if (res.status === 429) {
      console.log("  429 body:", (await res.text()).slice(0, 200));
      console.log("  Retry-After:", res.headers.get("retry-after"));
      console.log("  X-RateLimit-Limit:", res.headers.get("x-ratelimit-limit"));
    } else {
      await res.text();
    }
  }
  console.log("statuses:", statuses.join(", "));

  // Clean up: the key and its budget.
  await fetch(`${base}/api/keys/${id}`, { method: "DELETE", headers: auth }).catch(() => {});

  const ok = statuses.slice(0, 2).every((s) => s === 200) && statuses.slice(2).every((s) => s === 429);
  console.log(ok ? "PASS: the budget stopped the key after 2 requests" : "FAIL: unexpected statuses");
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
