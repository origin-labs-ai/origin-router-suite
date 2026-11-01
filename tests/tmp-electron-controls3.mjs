import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const APP_PID = Number(process.argv[2] || 27412);
const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const stateScript = "C:\\Users\\thaku\\Workspaces\\9router\\tests\\window-state.ps1";
const state = (action = "state") => JSON.parse(execFileSync(PS, [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", stateScript,
  "-ProcessId", String(APP_PID), "-Action", action,
], { encoding: "utf8", windowsHide: true }).trim());

const browser = await chromium.connectOverCDP("http://127.0.0.1:9224");
const page = browser.contexts().flatMap((c) => c.pages())[0];

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

const before = state();
await page.evaluate(() => window.originRouterDesktop.minimize());
await page.waitForTimeout(800);
const minimized = state();
const restored = state("restore");
await page.waitForTimeout(600);

await page.evaluate(() => window.originRouterDesktop.toggleMaximize());
await page.waitForTimeout(800);
const maximized = state();
await page.evaluate(() => window.originRouterDesktop.toggleMaximize());
await page.waitForTimeout(800);
const normalAgain = state();

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

await page.screenshot({ path: "C:\\Users\\thaku\\Workspaces\\9router\\tests\\proof-electron-controls.png", timeout: 30000 });
console.log(JSON.stringify({ ui, states: { before, minimized, restored, maximized, normalAgain }, hover }, null, 2));

// Close button: the app should exit.
await page.evaluate(() => window.originRouterDesktop.close()).catch(() => {});
await new Promise((resolve) => setTimeout(resolve, 1500));
let closed = false;
try {
  execFileSync(PS, ["-NoProfile", "-Command", `if (Get-Process -Id ${APP_PID} -ErrorAction SilentlyContinue) { exit 1 } else { exit 0 }`], { windowsHide: true });
  closed = true;
} catch {
  closed = false;
}
console.log(JSON.stringify({ closedAfterCloseButton: closed }));
await browser.close().catch(() => {});
