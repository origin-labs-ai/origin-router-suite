// Screenshots of the new 0.6.000 surfaces: the provider health card on the
// usage page and the per-key limits on the endpoint page.
// Usage: node scripts/shoot-features.js [outdir] [dark|light]
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const base = process.env.OR_BASE || "http://127.0.0.1:20128";
const outDir = process.argv[2] || path.resolve("images/features");
const theme = process.argv[3] || "dark";

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  await context.request.post(`${base}/api/auth/login`, { data: { password: process.env.OR_LOGIN_PASSWORD || "123456" } });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 300)));
  await page.addInitScript(
    (t) => { try { localStorage.setItem("theme", JSON.stringify({ state: { theme: t }, version: 0 })); } catch {} },
    theme
  );
  fs.mkdirSync(outDir, { recursive: true });

  // Usage page: the provider health card.
  await page.goto(`${base}/dashboard/usage?tab=overview`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(9000);
  const all = page.getByRole("button", { name: "All", exact: true });
  if (await all.count()) { await all.first().click(); await page.waitForTimeout(2500); }

  const health = page.locator("text=PROVIDER HEALTH").first();
  if (await health.count()) {
    const card = page.locator("div").filter({ has: health }).last();
    await health.scrollIntoViewIfNeeded();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, "provider-health.png") });
    console.log("saved provider-health.png");
  } else {
    console.log("provider health card not found");
  }

  // Endpoint page: the per-key limits.
  await page.goto(`${base}/dashboard/endpoint`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(7000);
  const limits = page.locator("text=Limits:").first();
  if (await limits.count()) {
    await limits.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await limits.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(outDir, "key-limits.png") });
    console.log("saved key-limits.png");
  } else {
    await page.screenshot({ path: path.join(outDir, "endpoint.png") });
    console.log("saved endpoint.png (limits row not found)");
  }

  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
