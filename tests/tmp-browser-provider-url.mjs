import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const out = {};

await page.goto("http://127.0.0.1:20129/dashboard/providers", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);
const link = page.locator('a[href*="/dashboard/providers/LarpRouter"]');
out.customLink = await link.count();
if (out.customLink) {
  await link.first().click();
  await page.waitForTimeout(4000);
  out.urlAfterClick = page.url();
  out.heading = (await page.locator("h1, h2").allTextContents()).filter((t) => t.trim()).slice(0, 6);
  await page.screenshot({ path: "C:\\Users\\thaku\\Workspaces\\OR\\tests\\proof-provider-name-url.png" });
}

await page.goto("http://127.0.0.1:20129/dashboard/skills", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(2000);
out.skillsText = (await page.locator("main").innerText()).replace(/\s+/g, " ").trim().slice(0, 160);
out.donateOnSkills = await page.getByText("Donate", { exact: true }).count();

console.log(JSON.stringify(out, null, 2));
await browser.close();
