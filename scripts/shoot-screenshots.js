// Dashboard screenshots in both themes.
// Usage: node scripts/shoot-screenshots.js <outDir> [baseUrl]
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const outDir = path.resolve(process.argv[2] || "images");
const base = process.argv[3] || "http://127.0.0.1:20128";

const THEME_SCRIPT = (theme) => `try{localStorage.setItem('theme', JSON.stringify({state:{theme:'${theme}'},version:0}))}catch(e){}`;

const SHOTS = [
  { url: "/dashboard/providers", name: "providers", themes: ["dark", "light"] },
  { url: "/dashboard/combos", name: "combos", themes: ["dark", "light"] },
  { url: "/dashboard/token-saver", name: "token-saver", themes: ["dark", "light"] },
  { url: "/dashboard/quota", name: "quota", themes: ["dark", "light"] },
];

async function launch() {
  try {
    return await chromium.launch({ args: ["--force-color-profile=srgb", "--font-render-hinting=none"] });
  } catch (e) {
    console.log("bundled chromium failed, falling back to installed Chrome:", e.message);
    return await chromium.launch({ channel: "chrome", args: ["--force-color-profile=srgb"] });
  }
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await launch();
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });

  // Log in once; the cookie lands in this browser context.
  const login = await context.request.post(`${base}/api/auth/login`, {
    data: { password: process.env.OR_LOGIN_PASSWORD || "123456" },
  });
  console.log("login:", login.status(), (await login.text()).slice(0, 120));

  const page = await context.newPage();
  for (const shot of SHOTS) {
    for (const theme of shot.themes) {
      await page.addInitScript(THEME_SCRIPT(theme));
      await page.goto(base + shot.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3500);
      // Force the theme class even when the store restored "system".
      await page.evaluate((t) => {
        document.documentElement.classList.toggle("dark", t === "dark");
      }, theme);
      await page.waitForTimeout(600);
      const file = path.join(outDir, `${shot.name}-${theme}.png`);
      await page.screenshot({ path: file });
      const kb = Math.round(fs.statSync(file).size / 1024);
      console.log(`saved ${file} (${kb} KB)`);
    }
  }

  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
