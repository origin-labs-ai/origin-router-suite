import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9226");
const page = browser.contexts()[0].pages()[0];
const out = {};

async function load() {
  await page.goto("http://127.0.0.1:20128/dashboard/playground", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="model-picker-trigger"]');
    return el && !el.innerText.includes("Select model");
  }, { timeout: 45000 });
}

async function openSearch(query, filter = "0") {
  await page.locator('[data-testid="model-picker-trigger"]').click();
  await page.waitForSelector('[data-testid="model-picker-menu"]');
  await page.selectOption('[data-testid="context-filter"]', filter);
  await page.fill('[data-testid="model-search"]', query);
  await page.waitForTimeout(500);
  const index = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) =>
    nodes.findIndex((n) => Number(n.getAttribute("data-provider-count")) > 1)
  );
  if (index < 0) return null;
  await page.locator('[data-testid="model-group"]').nth(index).click();
  await page.waitForSelector('[data-testid="provider-option"]');
  const providers = await page.locator('[data-testid="provider-option"]').evaluateAll((nodes) =>
    nodes.map((n) => n.innerText.replace(/\s+/g, " ").trim())
  );
  return providers;
}

await load();
out.any = await openSearch("claude sonnet 5.5", "0");

await page.goto("http://127.0.0.1:20128/dashboard/playground", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
out.oneM = await openSearch("claude sonnet 5.5", "1000000");
out.allOneM = out.oneM ? out.oneM.every((t) => /1M ctx/.test(t)) : null;
console.log(JSON.stringify(out, null, 2));
await browser.close();
