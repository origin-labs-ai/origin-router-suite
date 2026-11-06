// Screenshot the first-run wizard, step by step.
// Usage: node scripts/shoot-wizard.js [outdir] [dark|light]
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const base = process.env.OR_BASE || "http://127.0.0.1:20127";
const outDir = process.argv[2] || path.resolve("images/wizard");
const theme = process.argv[3] || "dark";

(async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  const login = await context.request.post(`${base}/api/auth/login`, { data: { password: process.env.OR_LOGIN_PASSWORD || "123456" } });
  console.log("login:", login.status());
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 400)));
  page.on("console", (msg) => { if (msg.type() === "error") console.log("[console]", msg.text().slice(0, 300)); });
  await page.addInitScript(
    (t) => { try { localStorage.setItem("theme", JSON.stringify({ state: { theme: t }, version: 0 })); } catch {} },
    theme
  );

  fs.mkdirSync(outDir, { recursive: true });
  await page.goto(`${base}/dashboard/welcome`, { waitUntil: "domcontentloaded", timeout: 120000 });
  await page.waitForSelector("text=Get Started with OriginRouter", { timeout: 90000 }).catch(() => {
    console.log("wizard did not appear");
  });
  await page.waitForTimeout(2500);

  const steps = ["Theme", "Migrate", "Provider", "Combo", "Tuning", "Claude Code", "Finish"];
  for (let i = 0; i < steps.length; i++) {
    await page.screenshot({ path: path.join(outDir, `wizard-${i + 1}-${steps[i].toLowerCase().replace(/\s+/g, "-")}.png`) });
    console.log("saved", steps[i]);
    if (i < steps.length - 1) {
      const next = page.getByRole("button", { name: "Next", exact: true });
      if (await next.count()) {
        await next.first().click();
        await page.waitForTimeout(1200);
      } else {
        break;
      }
    }
  }

  await browser.close();
})().catch((e) => { console.error("FAILED:", e); process.exit(1); });
