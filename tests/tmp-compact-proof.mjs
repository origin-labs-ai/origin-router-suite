import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { chromium } from "playwright-core";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9226");
const context = browser.contexts()[0];
const page = context.pages()[0];

await page.waitForTimeout(2000);
await page.mouse.move(600, 2);
await page.waitForTimeout(400);
const bar = await page.evaluate(() => {
  const name = document.querySelector(".or-titlebar-name");
  const controls = document.querySelector(".or-titlebar-controls");
  const buttons = [...document.querySelectorAll(".or-titlebar-btn")];
  const style = (el) => el ? {
    rect: el.getBoundingClientRect().toJSON(),
    background: getComputedStyle(el).backgroundColor,
    blur: getComputedStyle(el).backdropFilter,
    border: getComputedStyle(el).border,
    radius: getComputedStyle(el).borderRadius,
    text: el.innerText.trim(),
  } : null;
  return {
    url: location.pathname,
    name: style(name),
    controls: style(controls),
    buttons: buttons.map((b) => b.getBoundingClientRect().width),
    buttonRadius: buttons[0] ? getComputedStyle(buttons[0]).borderRadius : null,
    frame: document.querySelector(".or-app-shell") ? {
      rect: document.querySelector(".or-app-shell").getBoundingClientRect().toJSON(),
      border: getComputedStyle(document.querySelector(".or-app-shell")).border,
      radius: getComputedStyle(document.querySelector(".or-app-shell")).borderRadius,
    } : null,
    bodyPadding: getComputedStyle(document.body).padding,
  };
});
console.log(JSON.stringify(bar, null, 2));
await page.screenshot({ path: "C:\\Users\\thaku\\Workspaces\\OR\\tests\\proof-compact-titlebar.png" });

// Establish a dashboard session for verification only.
const secret = fs.readFileSync(path.join(os.homedir(), ".or", "jwt-secret"), "utf8").trim();
const token = await new SignJWT({ authenticated: true })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("2h")
  .sign(new TextEncoder().encode(secret));
await context.addCookies([{
  name: "auth_token",
  value: token,
  domain: "127.0.0.1",
  path: "/",
  httpOnly: true,
  sameSite: "Lax",
}]);
await page.goto("http://127.0.0.1:20128/dashboard/playground", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(8000);
await page.mouse.move(600, 2);
await page.waitForTimeout(300);
await page.screenshot({ path: "C:\\Users\\thaku\\Workspaces\\OR\\tests\\proof-compact-playground.png" });

const trigger = page.locator('[data-testid="model-picker-trigger"]');
if (await trigger.count()) {
  await trigger.click();
  await page.waitForSelector('[data-testid="model-picker-menu"]');
  const menu = page.locator('[data-testid="model-picker-menu"]');
  const header = (await menu.innerText()).match(/Total [\d,]+ models · [\d,]+ categories/)?.[0];
  await page.fill('[data-testid="model-search"]', "claude sonnet 5.5");
  await page.waitForTimeout(400);
  const multi = await page.locator('[data-testid="model-group"]').evaluateAll((nodes) =>
    nodes.findIndex((n) => Number(n.getAttribute("data-provider-count")) > 1)
  );
  if (multi >= 0) {
    await page.locator('[data-testid="model-group"]').nth(multi).click();
    await page.waitForSelector('[data-testid="provider-option"]');
    const providersAny = await page.locator('[data-testid="provider-option"]').evaluateAll((nodes) =>
      nodes.map((n) => n.innerText.replace(/\s+/g, " ").trim())
    );
    const group = await page.locator('[data-testid="model-group"]').nth(multi).getAttribute("data-model").catch(() => "");
    console.log(JSON.stringify({ header, totalProviders: providersAny.length, providersAny: providersAny.slice(0, 4), group }));
  } else {
    console.log(JSON.stringify({ header, error: "no multi-provider category" }));
  }
}
await browser.close();
