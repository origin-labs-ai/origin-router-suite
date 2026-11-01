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
}, { timeout: 60000 });
const trigger = page.locator('[data-testid="model-picker-trigger"]');
await trigger.click();
await page.waitForSelector('[data-testid="model-picker-menu"]');
const menu = page.locator('[data-testid="model-picker-menu"]');
const readHeader = async () => (await menu.innerText()).match(/Total [\d,]+ models · [\d,]+ categories/)?.[0];
const out = { headerAny: await readHeader(), rendered: await page.locator('[data-testid="model-group"]').count() };
out.sections = await menu.locator("text=Combos").count() + "/" + await menu.locator("text=Model categories").count();

await page.fill('[data-testid="model-search"]', "glm");
await page.waitForTimeout(400);
out.glmGroups = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) => nodes.slice(0, 8).map((n) => ({
  name: n.getAttribute("data-model"),
  vendor: n.getAttribute("data-vendor"),
  providers: Number(n.getAttribute("data-provider-count")),
  context: Number(n.getAttribute("data-context")),
})));

await page.fill('[data-testid="model-search"]', "120b");
await page.waitForTimeout(400);
out.sizeGroups = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) => nodes.slice(0, 6).map((n) => n.getAttribute("data-model")));

await page.fill('[data-testid="model-search"]', "@");
await page.waitForTimeout(400);
out.atSearchCount = await page.locator('[data-testid="model-group"]').count();

await page.fill('[data-testid="model-search"]', "claude fable 5");
await page.waitForTimeout(400);
out.fableGroups = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) => nodes.slice(0, 6).map((n) => ({
  name: n.getAttribute("data-model"),
  providers: Number(n.getAttribute("data-provider-count")),
})));
const multiIndex = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) =>
  nodes.findIndex((n) => Number(n.getAttribute("data-provider-count")) > 1)
);
if (multiIndex >= 0) {
  await page.locator('[data-testid="model-group"]').nth(multiIndex).click();
  await page.waitForSelector('[data-testid="provider-option"]');
  out.providersAny = await page.locator('[data-testid="provider-option"]').evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-provider")));
  await page.locator(".or-titlebar, body").first().click({ position: { x: 1, y: 1 } }).catch(() => {});
  // Reopen and apply the 1M filter, then inspect providers again.
  if (await menu.count()) await page.keyboard.press("Escape").catch(() => {});
  if (!(await menu.count())) await trigger.click();
  await page.waitForTimeout(300);
}
console.log(JSON.stringify(out, null, 2));
await page.screenshot({ path: "tests/proof-categories.png" });
await browser.close();
