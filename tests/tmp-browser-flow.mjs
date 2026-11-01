import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (err) => console.log("[page error]", err.message.slice(0, 300)));

const out = {};
await page.goto("http://127.0.0.1:20129/dashboard/playground", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForFunction(() => {
  const el = document.querySelector('[data-testid="model-picker-trigger"]');
  return el && !el.innerText.includes("Select model");
}, { timeout: 45000 });

const trigger = page.locator('[data-testid="model-picker-trigger"]');
out.initialLabel = (await trigger.innerText()).replace(/\s+/g, " ").trim();

await trigger.click();
await page.waitForSelector('[data-testid="model-picker-menu"]');
out.menuHeaderAny = (await page.locator('[data-testid="model-picker-menu"]').innerText()).match(/([\d,]+) models · ([\d,]+) routes/)?.[0] || "?";
out.renderedGroups = await page.locator('[data-testid="model-group"]').count();

const readCount = async (value) => {
  await page.selectOption('[data-testid="context-filter"]', value);
  await page.waitForTimeout(400);
  const text = await page.locator('[data-testid="model-picker-menu"]').innerText();
  const match = text.match(/([\d,]+) models · ([\d,]+) routes/);
  return { text: match?.[0] || "?", groups: await page.locator('[data-testid="model-group"]').count() };
};

out.filter1M = await readCount("1000000");
out.filter200K = await readCount("200000");
out.filter128K = await readCount("128000");
await page.selectOption('[data-testid="context-filter"]', "0");

// Search Claude and inspect exact-model groups. Antigravity serving Anthropic
// must show vendor Anthropic, not a provider called Anthropic.
await page.fill('[data-testid="model-search"]', "claude");
await page.waitForTimeout(400);
const groups = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) => nodes.map((n) => ({
  model: n.getAttribute("data-model"),
  vendor: n.getAttribute("data-vendor"),
  providers: Number(n.getAttribute("data-provider-count")),
  context: Number(n.getAttribute("data-context")),
})).slice(0, 20));
out.claudeGroups = groups;

const multiIndex = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) =>
  nodes.findIndex((n) => Number(n.getAttribute("data-provider-count")) > 1)
);
if (multiIndex === -1) {
  out.error = "No multi-provider Claude group found";
} else {
  const group = page.locator('[data-testid="model-group"]').nth(multiIndex);
  out.pickedGroup = await group.evaluate((n) => ({
    model: n.getAttribute("data-model"),
    vendor: n.getAttribute("data-vendor"),
    providers: Number(n.getAttribute("data-provider-count")),
  }));
  await group.click();
  await page.waitForSelector('[data-testid="random-provider"]');
  out.providerOptions = await page.locator('[data-testid="provider-option"]').evaluateAll((nodes) =>
    nodes.map((n) => ({ provider: n.getAttribute("data-provider"), text: n.innerText.replace(/\s+/g, " ").trim() }))
  );
  out.hasAntigravity = out.providerOptions.some((p) => /antigravity/i.test(p.provider));
  await page.screenshot({ path: "tests/proof-provider-step.png" });

  await page.locator('[data-testid="random-provider"]').click();
  await page.waitForSelector('[data-testid="context-option"]');
  out.contextOptions = await page.locator('[data-testid="context-option"]').evaluateAll((nodes) =>
    nodes.map((n) => Number(n.getAttribute("data-value")))
  );
  out.skipLabel = (await page.locator('[data-testid="skip-context"]').innerText()).replace(/\s+/g, " ").trim();
  out.selectedByDefault = await page.locator('[data-testid="context-option"]').evaluateAll((nodes) =>
    nodes.filter((n) => n.className.includes("2B7FFF/60")).map((n) => Number(n.getAttribute("data-value")))
  );
  await page.screenshot({ path: "tests/proof-context-step.png" });

  await page.locator('[data-testid="skip-context"]').click();
  await page.waitForTimeout(500);
  out.afterSkipLabel = (await trigger.innerText()).replace(/\s+/g, " ").trim();
  out.menuClosedAfterSkip = await page.locator('[data-testid="model-picker-menu"]').count() === 0;
  await page.screenshot({ path: "tests/proof-after-skip.png" });
}

console.log(JSON.stringify(out, null, 2));
await browser.close();
