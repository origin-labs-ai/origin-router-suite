import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap((c) => c.pages())[0];
page.setDefaultTimeout(60000);

await page.goto("http://127.0.0.1:20128/dashboard/playground", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="model-picker-trigger"]');
  return el && !el.innerText.includes("Select model");
}, { timeout: 60000 });

const trigger = page.locator('[data-testid="model-picker-trigger"]');
const out = { initial: (await trigger.innerText()).replace(/\s+/g, " ").trim() };
await trigger.click();
await page.waitForSelector('[data-testid="model-picker-menu"]');
out.header = (await page.locator('[data-testid="model-picker-menu"]').innerText()).match(/[\d,]+ routes · [\d,]+ exact models/)?.[0];
out.rendered = await page.locator('[data-testid="model-group"]').count();

await page.selectOption('[data-testid="context-filter"]', "1000000");
await page.waitForTimeout(400);
out.filter1M = (await page.locator('[data-testid="model-picker-menu"]').innerText()).match(/[\d,]+ routes · [\d,]+ exact models/)?.[0];
await page.selectOption('[data-testid="context-filter"]', "0");

await page.fill('[data-testid="model-search"]', "sonnet 5.5");
await page.waitForTimeout(400);
let index = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) =>
  nodes.findIndex((n) => Number(n.getAttribute("data-provider-count")) > 1)
);
if (index < 0) index = 0;
const group = page.locator('[data-testid="model-group"]').nth(index);
out.group = await group.evaluate((n) => ({
  model: n.getAttribute("data-model"),
  vendor: n.getAttribute("data-vendor"),
  providers: Number(n.getAttribute("data-provider-count")),
  context: Number(n.getAttribute("data-context")),
}));
await group.click();
await page.waitForSelector('[data-testid="provider-option"], [data-testid="context-option"]');
out.providers = await page.locator('[data-testid="provider-option"]').evaluateAll((nodes) =>
  nodes.map((n) => n.getAttribute("data-provider"))
);
out.hasAntigravity = out.providers.includes("Antigravity");
if (out.providers.length > 0) {
  await page.locator('[data-testid="random-provider"]').click();
  await page.waitForSelector('[data-testid="context-option"]');
  out.contextOptions = await page.locator('[data-testid="context-option"]').evaluateAll((nodes) =>
    nodes.map((n) => Number(n.getAttribute("data-value")))
  );
  out.skip = (await page.locator('[data-testid="skip-context"]').innerText()).replace(/\s+/g, " ").trim();
  console.log(JSON.stringify(out, null, 2));
  await page.locator('[data-testid="skip-context"]').click();
  await page.waitForTimeout(500);
  out.afterSkip = (await trigger.innerText()).replace(/\s+/g, " ").trim();
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
