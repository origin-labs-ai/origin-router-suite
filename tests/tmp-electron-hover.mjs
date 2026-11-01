import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap((c) => c.pages())[0];
await page.mouse.move(400, 1);
await page.waitForTimeout(300);
const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));

const read = async (x, y, selector) => {
  await page.mouse.move(x, y);
  await page.waitForTimeout(250);
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, color: s.color };
  }, selector);
};

const min = await read(size.w - 115, 16, ".or-titlebar-btn:nth-child(1)");
const max = await read(size.w - 69, 16, ".or-titlebar-btn:nth-child(2)");
const close = await read(size.w - 23, 16, ".or-titlebar-btn:nth-child(3)");
console.log(JSON.stringify({ size, min, max, close }, null, 2));
await browser.close();
