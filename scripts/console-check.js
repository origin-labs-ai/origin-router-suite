// Print the browser console of a page, so a broken render can be seen.
const { chromium } = require("playwright-core");

const base = process.env.OR_BASE || "http://127.0.0.1:20128";
const target = process.argv[2] || "/dashboard/usage?tab=overview";

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.request.post(`${base}/api/auth/login`, { data: { password: process.env.OR_LOGIN_PASSWORD || "123456" } });
  const page = await context.newPage();
  page.on("console", (msg) => console.log(`[${msg.type()}]`, msg.text().slice(0, 500)));
  page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 900)));
  page.on("requestfailed", (req) => console.log("[requestfailed]", req.url(), req.failure()?.errorText));
  page.on("response", (res) => { if (res.status() >= 400) console.log("[http]", res.status(), res.url()); });
  await page.goto(`${base}${target}`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(Number(process.env.OR_WAIT || 10000));
  console.log("--- testid count:", await page.locator('[data-testid="provider-bar-chart"]').count());
  const info = await page.evaluate(() => ({
    surfaces: document.querySelectorAll("svg.recharts-surface").length,
    emptyProviderChart: document.body.innerText.includes("No provider usage yet"),
    topModels: document.body.innerText.includes("TOP MODELS"),
    tokensButtons: Array.from(document.querySelectorAll("button")).filter((b) => b.innerText.trim() === "Tokens").length,
    testids: Array.from(document.querySelectorAll("[data-testid]")).map((el) => el.getAttribute("data-testid")).slice(0, 10),
  }));
  console.log("--- dom:", JSON.stringify(info, null, 2));
  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
