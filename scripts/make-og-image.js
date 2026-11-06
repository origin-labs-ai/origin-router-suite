// Renders the social preview card to public/og-image.png.
// The image is what LinkedIn, X and Reddit show for a bare repo link, so it is
// generated from the real dashboard screenshot instead of a mock-up.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const repoRoot = path.resolve(__dirname, "..");
const outFile = path.join(repoRoot, "public", "og-image.png");
const shot = path.join(repoRoot, "images", "combos-dark.png");
const shotData = fs.existsSync(shot) ? fs.readFileSync(shot).toString("base64") : null;

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @import url('');
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:1200px; height:630px; overflow:hidden;
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    background:
      radial-gradient(700px 420px at 12% 8%, rgba(43,127,255,0.20), transparent 70%),
      radial-gradient(520px 380px at 92% 92%, rgba(168,85,247,0.14), transparent 70%),
      #0d0b09;
    color:#fff; position:relative;
  }
  .grid {
    position:absolute; inset:0; opacity:0.07;
    background-image:
      linear-gradient(to right, #2B7FFF 1px, transparent 1px),
      linear-gradient(to bottom, #2B7FFF 1px, transparent 1px);
    background-size: 50px 50px;
  }
  .wrap { position:relative; display:flex; height:100%; }
  .left { width:640px; padding:64px 0 64px 64px; display:flex; flex-direction:column; }
  .brand { display:flex; align-items:center; gap:16px; }
  .brand img { width:64px; height:64px; border-radius:16px; }
  .name { font-size:40px; font-weight:800; letter-spacing:-0.5px; }
  .name span { color:#2B7FFF; }
  h1 { font-size:46px; line-height:1.12; font-weight:800; margin:36px 0 0; letter-spacing:-1px; }
  h1 em { font-style:normal; color:#2B7FFF; }
  p.sub { font-size:21px; line-height:1.5; color:#9aa4b2; margin:20px 0 0; max-width:520px; }
  .chips { display:flex; flex-wrap:wrap; gap:10px; margin-top:32px; }
  .chip { font-size:16px; font-weight:600; color:#cbd5e1; padding:9px 16px; border-radius:999px; border:1px solid #2a2f3a; background:rgba(255,255,255,0.04); }
  .chip b { color:#fff; }
  .foot { margin-top:auto; font-size:17px; color:#6b7482; }
  .foot b { color:#8b95a5; font-weight:600; }
  .right { flex:1; position:relative; display:flex; align-items:center; justify-content:center; padding-right:48px; }
  .shot { width:520px; border-radius:14px; overflow:hidden; border:1px solid #23262e; box-shadow:0 40px 90px rgba(0,0,0,0.65); transform:rotate(-1.2deg); }
  .shot img { display:block; width:100%; }
  .badge { position:absolute; right:6px; bottom:70px; background:#111418; border:1px solid #23262e; border-radius:12px; padding:14px 18px; box-shadow:0 24px 60px rgba(0,0,0,0.6); }
  .badge .k { font-size:13px; color:#6b7482; letter-spacing:0.6px; text-transform:uppercase; }
  .badge .v { font-size:20px; font-weight:700; margin-top:3px; }
</style></head>
<body>
  <div class="grid"></div>
  <div class="wrap">
    <div class="left">
      <div class="brand">
        <img src="file://${path.join(repoRoot, "public", "brand", "origin-mark-256.png").replace(/\\/g, "/")}" alt="OriginRouter" />
        <div class="name">Origin<span>Router</span></div>
      </div>
      <h1>One endpoint for<br/>every <em>AI provider</em>.</h1>
      <p class="sub">Route across 90+ providers, fall back before an error ever reaches your code, and cut 60-90% of tool-output tokens.</p>
      <div class="chips">
        <div class="chip"><b>Panda + Jev</b> routing brain</div>
        <div class="chip"><b>4</b> combo strategies</div>
        <div class="chip"><b>Local-first</b>, one port</div>
      </div>
      <div class="foot"><b>origin-labs-ai/origin-router-suite</b> &nbsp;·&nbsp; MIT</div>
    </div>
    <div class="right">
      ${shotData ? `<div class="shot"><img src="data:image/png;base64,${shotData}" alt="dashboard" /></div>` : ""}
      <div class="badge"><div class="k">Routing brain</div><div class="v">Panda + Jev</div></div>
    </div>
  </div>
</body></html>`;

(async () => {
  const htmlFile = path.join(repoRoot, ".tmp-og.html");
  fs.writeFileSync(htmlFile, html, "utf8");
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ channel: "chrome" });
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto("file://" + htmlFile.replace(/\\/g, "/"), { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await page.screenshot({ path: outFile });
  await browser.close();
  fs.unlinkSync(htmlFile);
  console.log("wrote", outFile, Math.round(fs.statSync(outFile).size / 1024) + " KB");
})().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
