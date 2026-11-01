import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts().flatMap((c) => c.pages())[0];
const cdp = await page.context().newCDPSession(page);
const { windowId } = await cdp.send("Browser.getWindowForTarget");
const bounds = async () => (await cdp.send("Browser.getWindowBounds", { windowId })).bounds;

await page.mouse.move(600, 1);
await page.waitForTimeout(300);
const ui = await page.evaluate(() => {
  const bar = document.querySelector(".or-titlebar");
  return {
    bridge: Boolean(window.originRouterDesktop),
    bar: bar?.className,
    opacity: bar ? getComputedStyle(bar).opacity : null,
    height: bar ? getComputedStyle(bar).height : null,
    shellPadding: document.querySelector(".or-app-shell") ? getComputedStyle(document.querySelector(".or-app-shell")).paddingTop : null,
  };
});

const before = await bounds();
await page.evaluate(() => window.originRouterDesktop.minimize());
await page.waitForTimeout(700);
const minimized = await bounds();
await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
await page.waitForTimeout(700);
const restored = await bounds();

await page.evaluate(() => window.originRouterDesktop.toggleMaximize());
await page.waitForTimeout(700);
const maximized = await bounds();
const isMax = await page.evaluate(() => window.originRouterDesktop.isMaximized());
await page.evaluate(() => window.originRouterDesktop.toggleMaximize());
await page.waitForTimeout(700);
const normalAgain = await bounds();

await page.mouse.move(600, 1);
await page.waitForTimeout(300);
const size = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
const read = async (x, selector) => {
  await page.mouse.move(x, 16);
  await page.waitForTimeout(250);
  return page.evaluate((sel) => {
    const s = getComputedStyle(document.querySelector(sel));
    return { background: s.backgroundColor, color: s.color };
  }, selector);
};
const hover = {
  minimize: await read(size.w - 115, ".or-titlebar-btn:nth-child(1)"),
  maximize: await read(size.w - 69, ".or-titlebar-btn:nth-child(2)"),
  close: await read(size.w - 23, ".or-titlebar-btn:nth-child(3)"),
};

console.log(JSON.stringify({ ui, windowState: { before, minimized, restored, maximized, isMax, normalAgain }, hover }, null, 2));
await browser.close();
