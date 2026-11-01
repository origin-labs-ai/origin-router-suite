import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const contexts = browser.contexts();
const pages = contexts.flatMap((context) => context.pages());
console.log("pages", pages.length, pages.map((p) => p.url()));
const page = pages.find((p) => p.url().includes("20128")) || pages[0];
await page.waitForTimeout(1000);

const info = await page.evaluate(() => {
  const api = window.originRouterDesktop;
  const bar = document.querySelector(".or-titlebar");
  return {
    hasBridge: Boolean(api),
    bridgeKeys: api ? Object.keys(api) : [],
    htmlClass: document.documentElement.className,
    barExists: Boolean(bar),
    barClass: bar?.className || "",
    barOpacity: bar ? getComputedStyle(bar).opacity : null,
    barTransform: bar ? getComputedStyle(bar).transform : null,
    shellPaddingTop: document.querySelector(".or-app-shell") ? getComputedStyle(document.querySelector(".or-app-shell")).paddingTop : null,
    bodyPaddingTop: getComputedStyle(document.body).paddingTop,
    viewport: { width: innerWidth, height: innerHeight },
  };
});
console.log(JSON.stringify(info, null, 2));

// Move the pointer to the top edge, which should reveal the auto-hidden bar.
await page.mouse.move(400, 1);
await page.waitForTimeout(400);
const afterHover = await page.evaluate(() => {
  const bar = document.querySelector(".or-titlebar");
  const btn = document.querySelector(".or-titlebar-btn");
  return {
    barClass: bar?.className || "",
    barOpacity: bar ? getComputedStyle(bar).opacity : null,
    barHeight: bar ? getComputedStyle(bar).height : null,
    btnBg: btn ? getComputedStyle(btn).backgroundColor : null,
    btnColor: btn ? getComputedStyle(btn).color : null,
    closeBtnBg: document.querySelector(".or-titlebar-close") ? getComputedStyle(document.querySelector(".or-titlebar-close")).backgroundColor : null,
  };
});
console.log("afterHover", JSON.stringify(afterHover, null, 2));
await page.screenshot({ path: "tests/proof-electron-titlebar.png" });

const maxBefore = await page.evaluate(() => window.originRouterDesktop.isMaximized());
await page.locator(".or-titlebar-btn").nth(1).click();
await page.waitForTimeout(800);
const maxAfter = await page.evaluate(() => window.originRouterDesktop.isMaximized());
console.log("maximize", { maxBefore, maxAfter });
await page.locator(".or-titlebar-btn").nth(1).click();
await page.waitForTimeout(800);
const maxRestored = await page.evaluate(() => window.originRouterDesktop.isMaximized());
console.log("restore", { maxRestored });

// Hover colours: close = red + white, min/max = light grey + black.
await page.mouse.move(100, 16);
await page.waitForTimeout(300);
const hoverColors = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll(".or-titlebar-btn")];
  const pick = (el) => {
    const s = getComputedStyle(el);
    return { background: s.backgroundColor, color: s.color };
  };
  return { minimize: pick(buttons[0]), maximize: pick(buttons[1]), close: pick(buttons[2]) };
});
console.log("hoverColors", JSON.stringify(hoverColors, null, 2));
await browser.close();
