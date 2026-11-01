import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:20129/dashboard/playground", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="model-picker-trigger"]');
  return el && !el.innerText.includes("Select model");
}, { timeout: 45000 });
await page.locator('[data-testid="model-picker-trigger"]').click();
await page.waitForSelector('[data-testid="model-picker-menu"]');

const results = [];
for (const query of ["sonnet 5.5", "opus 5.5", "sonnet", "antigravity"]) {
  await page.fill('[data-testid="model-search"]', query);
  await page.waitForTimeout(400);
  const groups = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) => nodes.map((n) => ({
    model: n.getAttribute("data-model"),
    vendor: n.getAttribute("data-vendor"),
    providers: Number(n.getAttribute("data-provider-count")),
    context: Number(n.getAttribute("data-context")),
  })).slice(0, 8));
  results.push({ query, groups });
}

// Open the first Claude Sonnet 5.5 group that has more than one provider.
await page.fill('[data-testid="model-search"]', "sonnet 5.5");
await page.waitForTimeout(400);
let index = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) =>
  nodes.findIndex((n) => Number(n.getAttribute("data-provider-count")) > 1)
);
if (index < 0) index = 0;
const group = page.locator('[data-testid="model-group"]').nth(index);
const picked = await group.evaluate((n) => ({
  model: n.getAttribute("data-model"),
  vendor: n.getAttribute("data-vendor"),
  providers: Number(n.getAttribute("data-provider-count")),
}));
await group.click();
await page.waitForSelector('[data-testid="provider-option"], [data-testid="context-option"]');
const providerOptions = await page.locator('[data-testid="provider-option"]').evaluateAll((nodes) =>
  nodes.map((n) => n.getAttribute("data-provider"))
);
let flow = "single-provider";
if (providerOptions.length > 0) {
  flow = "multi-provider";
  // Select yourself: click Antigravity when present, otherwise the first provider.
  const target = page.locator('[data-testid="provider-option"]').filter({ hasText: "Antigravity" });
  if (await target.count()) await target.first().click();
  else await page.locator('[data-testid="provider-option"]').first().click();
  await page.waitForSelector('[data-testid="context-option"]');
}
const contextOptions = await page.locator('[data-testid="context-option"]').evaluateAll((nodes) =>
  nodes.map((n) => ({ value: Number(n.getAttribute("data-value")), text: n.innerText.replace(/\s+/g, " ").trim() }))
);
// Pick the largest context and apply it.
const largest = contextOptions[contextOptions.length - 1];
await page.locator(`[data-testid="context-option"][data-value="${largest.value}"]`).click();
await page.locator('[data-testid="apply-context"]').click();
await page.waitForTimeout(500);
const after = (await page.locator('[data-testid="model-picker-trigger"]').innerText()).replace(/\s+/g, " ").trim();
await page.screenshot({ path: "tests/proof-antigravity.png" });

console.log(JSON.stringify({ results, picked, flow, providerOptions, contextOptions, after }, null, 2));
await browser.close();
