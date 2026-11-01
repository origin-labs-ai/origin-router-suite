import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  headless: true,
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("console", (msg) => {
  if (msg.type() === "error") console.log("[console error]", msg.text().slice(0, 300));
});
page.on("pageerror", (err) => console.log("[page error]", err.message.slice(0, 300)));

await page.goto("http://127.0.0.1:20129/dashboard/playground", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(20000);
console.log("title:", await page.title());
console.log("url:", page.url());
const buttons = await page.locator("button").allTextContents();
console.log("button count:", buttons.length);
console.log(buttons.slice(0, 40).map((t, i) => `${i}: ${t.replace(/\s+/g, " ").slice(0, 120)}`).join("\n"));
await page.screenshot({ path: "tests/playground-before-picker.png", fullPage: false });
await browser.close();
