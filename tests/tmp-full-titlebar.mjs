import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9227");
const context = browser.contexts()[0];
const page = context.pages()[0];
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("2h")
  .sign(new TextEncoder().encode(secret));
await context.addCookies([{ name: "auth_token", value: token, domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
await page.goto("http://127.0.0.1:20128/dashboard/playground", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(12000);
await page.mouse.move(600, 2);
await page.waitForTimeout(300);
const info = await page.evaluate(() => {
  const shell = document.querySelector(".or-app-shell");
  const bar = document.querySelector(".or-titlebar");
  const brand = document.querySelector(".or-titlebar-brand");
  const mark = document.querySelector(".or-titlebar-mark");
  const buttons = [...document.querySelectorAll(".or-titlebar-btn")];
  const r = (el) => el?.getBoundingClientRect().toJSON();
  return {
    url: location.pathname,
    shell: { rect: r(shell), paddingTop: shell ? getComputedStyle(shell).paddingTop : null, border: shell ? getComputedStyle(shell).border : null },
    bar: { rect: r(bar), opacity: bar ? getComputedStyle(bar).opacity : null, background: bar ? getComputedStyle(bar).backgroundColor : null, blur: bar ? getComputedStyle(bar).backdropFilter : null },
    brand: brand?.innerText.trim(),
    iconSrc: mark?.getAttribute("src"),
    iconRect: r(mark),
    buttons: buttons.map(r),
    buttonWidth: buttons[0] ? r(buttons[0]).width : null,
    titlebarOffset: getComputedStyle(document.documentElement).getPropertyValue("--or-titlebar-offset"),
  };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "C:\\Users\\thaku\\Workspaces\\OR\\tests\\proof-full-titlebar.png" });
await page.mouse.move(600, 500);
await page.waitForTimeout(1000);
const hidden = await page.evaluate(() => ({
  opacity: getComputedStyle(document.querySelector(".or-titlebar")).opacity,
  padding: getComputedStyle(document.querySelector(".or-app-shell")).paddingTop,
  offset: getComputedStyle(document.documentElement).getPropertyValue("--or-titlebar-offset"),
}));
console.log("hidden", JSON.stringify(hidden));
await browser.close();
