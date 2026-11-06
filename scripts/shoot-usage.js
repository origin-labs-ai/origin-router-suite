// Screenshot the usage page so the chart can be checked.
// Usage: node scripts/shoot-usage.js [outfile] [dark|light]
// Env: OR_BASE (default http://127.0.0.1:20128), OR_WAIT (ms)
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const base = process.env.OR_BASE || "http://127.0.0.1:20128";
const out = process.argv[2] || path.resolve("images/usage-chart.png");
const theme = process.argv[3] || "dark";

// The dashboard scrolls inside its own container, so the page itself never
// scrolls. These helpers find that container and move it.
async function scrollTo(page, top) {
  await page.evaluate((value) => {
    const candidates = Array.from(document.querySelectorAll("*")).filter((el) => {
      const style = window.getComputedStyle(el);
      return (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        el.scrollHeight > el.clientHeight + 40
      );
    });
    const target = candidates.sort((a, b) => b.clientHeight - a.clientHeight)[0];
    if (target) target.scrollTop = value;
    else window.scrollTo(0, value);
  }, top);
  await page.waitForTimeout(700);
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  const login = await context.request.post(`${base}/api/auth/login`, { data: { password: process.env.OR_LOGIN_PASSWORD || "123456" } });
  console.log("login:", login.status());
  const page = await context.newPage();
  await page.addInitScript(
    (t) => { try { localStorage.setItem("theme", JSON.stringify({ state: { theme: t }, version: 0 })); } catch {} },
    theme
  );
  await page.goto(`${base}/dashboard/usage?tab=overview`, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForTimeout(Number(process.env.OR_WAIT || 8000));

  // "Today" has no usage on a fresh database; "All" is where the provider
  // breakdown has something to show.
  const allButton = page.getByRole("button", { name: "All", exact: true });
  if (await allButton.count()) {
    await allButton.first().click();
    await page.waitForTimeout(2500);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });

  // The provider card on its own, so the labels can be checked closely.
  const chart = page.locator('[data-testid="provider-bar-chart"]');
  if (await chart.count()) {
    await chart.scrollIntoViewIfNeeded();
    await page.waitForTimeout(900);
    const chartOut = out.replace(/\.png$/, "-chart.png");
    await chart.screenshot({ path: chartOut });
    console.log("saved", chartOut);
  } else {
    console.log("provider chart not found (testid)");
  }

  // The card that holds it, for the surrounding layout.
  const card = page.locator('[data-testid="provider-bar-chart"]').locator("xpath=ancestor::*[contains(@class,'rounded')][1]");
  if (await card.count()) {
    const cardOut = out.replace(/\.png$/, "-card.png");
    await card.screenshot({ path: cardOut });
    console.log("saved", cardOut);
  }

  await scrollTo(page, 900);
  await page.screenshot({ path: out });
  console.log("saved", out);

  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
