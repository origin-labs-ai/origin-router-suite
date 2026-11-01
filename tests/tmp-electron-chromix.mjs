import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9225");
const page = browser.contexts().flatMap((c) => c.pages())[0];
await page.goto("http://127.0.0.1:20128/dashboard", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(4000);

const info = await page.evaluate(() => {
  const shell = document.querySelector(".or-app-shell");
  const bar = document.querySelector(".or-titlebar");
  const controls = document.querySelector(".or-titlebar-controls");
  const buttons = [...document.querySelectorAll(".or-titlebar-btn")];
  const rect = (el) => el ? el.getBoundingClientRect().toJSON() : null;
  return {
    htmlClass: document.documentElement.className,
    bodyPadding: getComputedStyle(document.body).padding,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    shellRect: rect(shell),
    shellBorder: shell ? getComputedStyle(shell).border : null,
    shellRadius: shell ? getComputedStyle(shell).borderRadius : null,
    barRect: rect(bar),
    barClass: bar?.className,
    barText: bar?.innerText.trim() || "",
    barBorder: bar ? getComputedStyle(bar).border : null,
    controlsRect: rect(controls),
    buttonRects: buttons.map(rect),
    buttonRadius: buttons[0] ? getComputedStyle(buttons[0]).borderRadius : null,
    brandNode: document.querySelector(".or-titlebar-brand")?.innerText || null,
  };
});
console.log(JSON.stringify(info, null, 2));

await page.mouse.move(600, 2);
await page.waitForTimeout(300);
await page.screenshot({ path: "C:\\Users\\thaku\\Workspaces\\OR\\tests\\proof-chromix-titlebar.png" });
const visible = await page.evaluate(() => getComputedStyle(document.querySelector(".or-titlebar")).opacity);
await page.mouse.move(600, 500);
await page.waitForTimeout(3200);
const hidden = await page.evaluate(() => getComputedStyle(document.querySelector(".or-titlebar")).opacity);
console.log(JSON.stringify({ afterRevealOpacity: visible, afterAutoHideOpacity: hidden }));
await browser.close();
