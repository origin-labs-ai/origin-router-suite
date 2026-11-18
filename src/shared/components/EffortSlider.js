"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { HYDRAFUSION_STOPS } from "open-sse/config/hydrafusion.js";

/**
 * The Claude Code effort slider, ported from dsh-claude-effort-slider.
 *
 * Geometry, colours, the 28px track, the 26×32 white knob, the 1.6s right-to-
 * left pixel reveal, per-row leftward pulses and the Ultra texture are the
 * original implementation's. The slider has the real six stops — Low, Medium,
 * High, Extra High, Max, Ultra — and the pixel grid stays at the original six
 * rows so the texture itself is unchanged.
 */

const TRACK_H = 28;
const KNOB_W = 26;
const KNOB_H = 32;
const KNOB_R = 8;
const POPOVER_W = 308;
const POPOVER_PAD = 16;
const TRACK_W = POPOVER_W - POPOVER_PAD * 2;
const CELL = TRACK_H / 6;

const DEFAULT_SETTINGS = { ticks: "show", texture: "normal" };
const SETTINGS_KEY = "originrouter.hydrafusion.slider.settings";

const CSS = `
.hf-chip{display:inline-flex;align-items:center;justify-content:center;height:24px;box-sizing:border-box;padding:0 9px;border:none;border-radius:7px;font:500 12px/1 system-ui,-apple-system,'Segoe UI',sans-serif;cursor:pointer;background:rgba(255,255,255,.085);color:rgba(235,237,241,.82);transition:background .12s ease,color .12s ease}
.hf-chip:hover{background:rgba(255,255,255,.14);color:#fff}
.hf-chip[data-ultra='1']{background:rgba(139,92,246,.22);color:#c4b5fd}
.hf-chip[data-ultra='1']:hover{background:rgba(139,92,246,.32);color:#ddd6fe}
.hf-chip[data-dark='0']{background:rgba(15,23,42,.055);color:rgba(27,28,32,.62)}
.hf-chip[data-dark='0']:hover{background:rgba(15,23,42,.1);color:rgba(27,28,32,.85)}
.hf-chip[data-dark='0'][data-ultra='1']{background:#ede9fe;color:#6d28d9}
.hf-chip[data-dark='0'][data-ultra='1']:hover{background:#ddd6fe;color:#5b21b6}
.hf-pop{position:fixed;z-index:2147482000;width:${POPOVER_W}px;box-sizing:border-box;padding:14px ${POPOVER_PAD}px 16px;border-radius:16px;background:rgba(38,42,47,.985);border:1px solid #454b52;box-shadow:0 8px 28px rgba(0,0,0,.35);color:#e3e5e8;font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px)}
.hf-pop[data-dark='0']{background:rgba(253,253,251,.99);border-color:#deded9;box-shadow:0 10px 26px rgba(15,23,42,.14);color:#393a36}
.hf-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.hf-title{font-size:17px;font-weight:500;line-height:24px;letter-spacing:.1px;color:#aeb3b8;white-space:nowrap}
.hf-pop[data-dark='0'] .hf-title{color:#888984}
.hf-value{margin-left:6px;color:#e3e5e8;font-weight:600;transition:color .2s ease;display:inline-block}
.hf-value[data-ultra='1']{color:#c4b2ee}
.hf-value.hf-glitch{animation:hf-glitch .3s steps(2,end)}
.hf-value-inner{display:inline-block;animation:hf-rise .3s cubic-bezier(.2,.85,.25,1)}
.hf-pop[data-dark='0'] .hf-value{color:#393a36}
.hf-pop[data-dark='0'] .hf-value[data-ultra='1']{color:#3d375b}
@keyframes hf-rise{0%{transform:translateY(85%) scale(.96);opacity:0}55%{opacity:1}80%{transform:translateY(-6%) scale(1.01)}100%{transform:translateY(0) scale(1);opacity:1}}
@keyframes hf-glitch{0%{transform:translate(0,0)}20%{transform:translate(-.6px,.3px);filter:blur(.25px) contrast(1.1);text-shadow:-1px 0 rgba(255,80,160,.6),1px 0 rgba(0,200,255,.6)}40%{transform:translate(.6px,-.3px);text-shadow:1px 0 rgba(255,80,160,.5),-1px 0 rgba(0,200,255,.5)}60%{transform:translate(-.4px,0);filter:blur(.15px);text-shadow:-1px 0 rgba(255,80,160,.35),1px 0 rgba(0,200,255,.35)}80%{transform:translate(.3px,0)}100%{transform:translate(0,0)}}
.hf-help{flex:0 0 auto;width:20px;height:20px;box-sizing:border-box;border-radius:50%;border:1px solid rgba(255,255,255,.3);background:none;color:rgba(255,255,255,.5);font:12px/1 system-ui,sans-serif;cursor:pointer;padding:0;display:grid;place-items:center}
.hf-help:hover{color:rgba(255,255,255,.8);border-color:rgba(255,255,255,.5)}
.hf-pop[data-dark='0'] .hf-help{border-color:rgba(15,23,42,.18);color:rgba(15,23,42,.45)}
.hf-labels{display:flex;justify-content:space-between;margin-top:16px;font-size:13px;line-height:16px;color:#aeb3b8}
.hf-pop[data-dark='0'] .hf-labels{color:#888984}
.hf-track{position:relative;height:${TRACK_H}px;margin-top:8px;border-radius:999px;background:#181d23;cursor:pointer;touch-action:none;user-select:none;-webkit-user-select:none;outline:none}
.hf-pop[data-dark='0'] .hf-track{background:#e4e3df}
.hf-track:focus-visible{box-shadow:0 0 0 2px rgba(167,139,250,.8)}
.hf-track[data-ultra='1'] .hf-tick{opacity:0}
.hf-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;background:#3b454e;overflow:hidden;pointer-events:none}
.hf-pop[data-dark='0'] .hf-fill{background:#e1e1dd}
.hf-track:not([data-drag='1']) .hf-fill{transition:width .12s cubic-bezier(.2,.8,.2,1)}
.hf-dither{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none}
.hf-tick{position:absolute;top:50%;width:2.5px;height:2.5px;margin:-1.25px 0 0 -1.25px;border-radius:50%;background:rgba(255,255,255,.32);pointer-events:none;transition:background .15s ease}
.hf-tick[data-on='1']{background:rgba(255,255,255,.95)}
.hf-tick[data-last='1']{background:rgba(255,255,255,.55);opacity:.9}
.hf-pop[data-dark='0'] .hf-tick{background:rgba(15,23,42,.22)}
.hf-pop[data-dark='0'] .hf-tick[data-on='1']{background:rgba(15,23,42,.5)}
.hf-pop[data-dark='0'] .hf-tick[data-last='1']{background:rgba(15,23,42,.4)}
.hf-knob{position:absolute;top:50%;width:${KNOB_W}px;height:${KNOB_H}px;margin:${-KNOB_H / 2}px 0 0 ${-KNOB_W / 2}px;border-radius:${KNOB_R}px;background:#fff;box-shadow:0 2px 6px rgba(0,0,0,.45),0 0 0 .5px rgba(0,0,0,.1);pointer-events:none}
.hf-pop[data-dark='0'] .hf-knob{box-shadow:0 2px 6px rgba(15,23,42,.2),0 0 0 .5px rgba(15,23,42,.06)}
.hf-track:not([data-drag='1']) .hf-knob{transition:left .12s cubic-bezier(.2,.8,.2,1)}
.hf-tip{margin-top:10px;font-size:11.5px;line-height:16px;color:rgba(235,237,241,.55)}
.hf-pop[data-dark='0'] .hf-tip{color:rgba(15,23,42,.6)}
.hf-set{margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;gap:8px}
.hf-pop[data-dark='0'] .hf-set{border-top-color:rgba(15,23,42,.08)}
.hf-set-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:12px;color:rgba(235,237,241,.75)}
.hf-pop[data-dark='0'] .hf-set-row{color:rgba(15,23,42,.75)}
.hf-set-btn{font:inherit;font-size:11.5px;color:#ddd6fe;background:rgba(139,92,246,.18);border:1px solid rgba(139,92,246,.3);border-radius:6px;padding:3px 9px;cursor:pointer}
.hf-set-btn:hover{background:rgba(139,92,246,.28)}
.hf-err{margin-top:8px;font-size:11px;line-height:15px;color:#f87171}
`;

function clamp01(value) {
  if (!(value > 0)) return 0;
  return value > 1 ? 1 : value;
}

function pctFromIndex(index, count) {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  return Math.max(0, Math.min(count - 1, index)) / (count - 1);
}

function indexFromPct(pct, count) {
  if (count <= 1) return 0;
  return Math.max(0, Math.min(count - 1, Math.round(clamp01(pct) * (count - 1))));
}

function xForPct(pct) {
  return KNOB_W / 2 + clamp01(pct) * (TRACK_W - KNOB_W);
}

function pctFromX(x) {
  return clamp01((x - KNOB_W / 2) / (TRACK_W - KNOB_W));
}

function hash01(a, b, c) {
  let h = (a | 0) * 374761393 + (b | 0) * 668265263 + (c | 0) * 1274126177;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return ((h >>> 0) % 100000) / 100000;
}

function ditherAlphaAt(x, w, col, row) {
  const t = clamp01(x / Math.max(1, w));
  const ramp = 0.92 + 0.08 * t;
  const jitter = 0.25 + 0.75 * hash01(col, row, 7);
  return clamp01(ramp * jitter);
}

function fillRoundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fill();
}

function valueNoise(col, row, timeSec, speed, seed) {
  const tt = timeSec * speed + hash01(col, row, seed) * 17;
  const step = Math.floor(tt);
  const f = tt - step;
  const e = f * f * (3 - 2 * f);
  const a = hash01(col, row, (step % 997) + seed * 11);
  const b = hash01(col, row, ((step + 1) % 997) + seed * 11);
  return a + (b - a) * e;
}

let mergeCache = null;
let mergeCacheKey = "";

function getMergeMap(cols, rows) {
  const key = `${cols}x${rows}`;
  if (mergeCache && mergeCacheKey === key) return mergeCache;
  const map = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      if (map[i]) continue;
      const h = hash01(c, r, 91);
      if (h < 0.02 && c + 1 < cols && r + 1 < rows && !map[i + 1] && !map[i + cols] && !map[i + cols + 1]) {
        map[i] = 1; map[i + 1] = 2; map[i + cols] = 2; map[i + cols + 1] = 2;
      } else if (h < 0.06 && c + 1 < cols && !map[i + 1]) {
        map[i] = 3; map[i + 1] = 2;
      } else if (h < 0.08 && r + 1 < rows && !map[i + cols]) {
        map[i] = 4; map[i + cols] = 2;
      }
    }
  }
  mergeCache = map;
  mergeCacheKey = key;
  return map;
}

/** One frame of the original dither texture, unchanged apart from its module. */
function paintDither(ctx, w, h, dark, progress, timeSec, intensity) {
  const strength = typeof intensity === "number" ? intensity : 1;
  ctx.clearRect(0, 0, w, h);
  const k = 1 - progress;
  const s1 = Math.max(0, Math.min(1, k - 0.08));
  const s2 = Math.max(s1, Math.min(1, k + 0.18));
  const wash = ctx.createLinearGradient(0, 0, w, 0);
  if (dark) {
    wash.addColorStop(0, "rgba(112,78,162,0)");
    wash.addColorStop(s1, "rgba(112,78,162,0)");
    wash.addColorStop(s2, "rgba(118,84,169,0.3)");
    wash.addColorStop(1, "rgba(116,84,170,0.75)");
  } else {
    wash.addColorStop(0, "rgba(142,118,192,0)");
    wash.addColorStop(s1, "rgba(142,118,192,0)");
    wash.addColorStop(s2, "rgba(142,118,192,0.45)");
    wash.addColorStop(1, "rgba(142,118,192,1)");
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);
  const purple = dark ? [208, 192, 246] : [150, 130, 205];
  const cell = CELL;
  const cols = Math.ceil(w / cell);
  const rows = Math.ceil(h / cell);
  for (let col = 0; col < cols; col += 1) {
    const x = col * cell;
    const t = clamp01(x / Math.max(1, w));
    const fade = clamp01((t - 0.02) / 0.48);
    for (let row = 0; row < rows; row += 1) {
      const base = ditherAlphaAt(x, w, col, row);
      if (base < 0.05) continue;
      const front = 1 - progress;
      const edgeJit = (hash01(col, row, 31) - 0.5) * 0.05;
      if (t < front + edgeJit) continue;
      const appear = 0.35 + 0.65 * clamp01((t - front - edgeJit) / 0.04);
      const rowWaves = 3 + Math.floor(hash01(0, row, 47) * 5);
      const rowSpeed = 5.0 + 10.0 * hash01(0, row, 43);
      const rowPhase = hash01(0, row, 53) * Math.PI * 2;
      const rowWaves2 = 2 + Math.floor(hash01(0, row, 61) * 4);
      const rowSpeed2 = rowSpeed * (rowWaves2 / rowWaves);
      const rowPhase2 = hash01(0, row, 71) * Math.PI * 2;
      let u1 = ((t * rowWaves * Math.PI * 2 + timeSec * rowSpeed + rowPhase) / (Math.PI * 2)) % 1;
      if (u1 < 0) u1 += 1;
      let u2 = ((t * rowWaves2 * Math.PI * 2 + timeSec * rowSpeed2 + rowPhase2) / (Math.PI * 2)) % 1;
      if (u2 < 0) u2 += 1;
      const p1 = Math.pow(1 - u1, 2.6 + 3.4 * hash01(col, row, 17));
      const p2 = Math.pow(1 - u2, 3.4);
      const pulse = Math.max(p1, p2 * (0.55 + 0.45 * hash01(col, row, 19))) * 0.85;
      if (!dark) {
        const lt = clamp01((t - 0.05) / 0.2);
        if (lt <= 0) continue;
        const lmap = getMergeMap(cols, rows);
        const mi = row * cols + col;
        const mv = lmap[mi];
        if (mv === 2) continue;
        if (hash01(col, row, 95) < 0.03) continue;
        const wide = mv === 3 || mv === 1;
        const tall = mv === 4 || mv === 1;
        const y2 = row * cell;
        const u = hash01(col, row, 93);
        const sp = 22 + 66 * t;
        let off = (u - 0.42) * sp;
        if (off > 0) off *= 1.1;
        const br = 187 - 32 * t;
        const bg = 184 - 46 * t;
        const bb = 206 + 4 * t;
        let lr = br + off;
        let lg = bg + (off < 0 ? off : off * 1.05);
        let lb = bb + (off < 0 ? off : off * 0.65);
        lr = Math.max(124, Math.min(240, Math.round(lr + 12 * pulse)));
        lg = Math.max(100, Math.min(232, Math.round(lg + 12 * pulse)));
        lb = Math.max(180, Math.min(252, Math.round(lb + 8 * pulse)));
        const lw = cell * (wide ? 2 : 1) * 0.88;
        const lh = cell * (tall ? 2 : 1) * 0.88;
        const flicker = valueNoise(col, row, timeSec, 0.9, 83);
        const density = clamp01((t - 0.12) / 0.35);
        const threshold = 0.2 + 0.8 * density;
        const presence = density > 0.9 ? 1 : clamp01((threshold - flicker) / 0.2);
        if (presence <= 0.01) continue;
        const lAlpha = clamp01(lt * appear * presence * (0.7 + 0.3 * (1 - flicker)) * (0.85 + 0.15 * hash01(col, row, 29)));
        ctx.globalAlpha = lAlpha;
        ctx.fillStyle = `rgb(${lr},${lg},${lb})`;
        fillRoundRect(ctx, x + 0.5, y2 + 0.5, lw, lh, 1);
        let whiteAmt = clamp01(pulse * (0.35 + 0.65 * t)) * (0.55 + 0.45 * hash01(col, row, 71)) * strength;
        if (progress < 0.999) {
          const flash = clamp01(1 - (t - front) / 0.16) * (0.55 + 0.45 * hash01(col, row, 73));
          whiteAmt = Math.max(whiteAmt, flash);
        }
        if (whiteAmt > 0.03) {
          ctx.globalAlpha = Math.min(1, lAlpha * (0.12 + 0.88 * whiteAmt));
          ctx.fillStyle = "rgb(247,243,255)";
          const ins = lw * 0.14;
          fillRoundRect(ctx, x + 0.5 + ins, y2 + 0.5 + ins, lw - ins * 2, lh - ins * 2, 0.7);
        }
        continue;
      }
      const flick = valueNoise(col, row, timeSec, 1.5, 5);
      const gap = dark ? (0.6 + 0.4 * clamp01((flick - (1 - fade) * 0.5) / 0.3)) : 1;
      const vis = clamp01((t - 0.2) / 0.18);
      const ghost = 0.06 * clamp01((flick - 0.5) / 0.5) * (1 - vis);
      const lvis = clamp01((t - 0.12) / 0.32);
      const baseAlpha = dark ? (0.04 + 0.96 * vis + ghost) : (lvis * (0.9 + 0.1 * t));
      const gridAlpha = clamp01(base * baseAlpha * gap * appear * (dark ? 1.15 : 1.9) * (0.9 + 0.1 * hash01(col, row, 29)) * strength);
      if (gridAlpha < 0.008) continue;
      const y = row * cell;
      const size = cell * 0.72;
      ctx.globalAlpha = Math.min(1, gridAlpha * (dark ? 0.55 : 1));
      ctx.fillStyle = `rgb(${purple[0]},${purple[1]},${purple[2]})`;
      fillRoundRect(ctx, x + 0.5, y + 0.5, size, size, 1.1);
      let whiteAmt = clamp01(pulse * (0.35 + 0.65 * t)) * (0.55 + 0.45 * hash01(col, row, 71)) * strength;
      if (progress < 0.999) {
        const flash = clamp01(1 - (t - front) / 0.16) * (0.55 + 0.45 * hash01(col, row, 73));
        whiteAmt = Math.max(whiteAmt, flash);
      }
      if (whiteAmt > 0.03) {
        ctx.globalAlpha = Math.min(1, gridAlpha * (0.1 + 0.72 * whiteAmt));
        ctx.fillStyle = dark ? "rgb(220,204,255)" : "rgb(214,202,242)";
        fillRoundRect(ctx, x + 0.5, y + 0.5, size, size, 0.7);
      }
    }
  }
  ctx.globalAlpha = 1;
}

let lastPlayedKey = null;

function DitherCanvas({ dark, opacity = 1, intensity = 1, animKey, playSeq, sweep = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return undefined;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(TRACK_W * dpr);
    canvas.height = Math.round(TRACK_H * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let start = 0;
    let raf = 0;
    const alreadyPlayed = Boolean(animKey && animKey === lastPlayedKey);
    const frame = (now) => {
      if (start === 0) start = now;
      const progress = alreadyPlayed ? 1 : (sweep ? Math.min(1, (now - start) / 1600) : 1);
      if (!alreadyPlayed && progress >= 1 && animKey) lastPlayedKey = animKey;
      paintDither(ctx, TRACK_W, TRACK_H, dark, progress, (now - start) / 1000, intensity);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [dark, intensity, sweep, animKey, playSeq]);
  return <canvas ref={ref} className="hf-dither" aria-hidden="true" style={{ opacity }} />;
}

function readSettings() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) || "null");
    return {
      ticks: parsed?.ticks === "hide" ? "hide" : "show",
      texture: parsed?.texture === "soft" ? "soft" : "normal",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function surfaceIsDark() {
  try {
    if (typeof document === "undefined" || !document.body) return true;
    if (document.documentElement.classList.contains("dark")) return true;
    if (document.documentElement.classList.contains("light")) return false;
    const bg = window.getComputedStyle(document.body).backgroundColor || "";
    const parts = bg.match(/[\d.]+/g);
    if (!parts || parts.length < 3) return true;
    if (parts.length > 3 && Number(parts[3]) < 0.5) return true;
    const luminance = (0.2126 * Number(parts[0]) + 0.7152 * Number(parts[1]) + 0.0722 * Number(parts[2])) / 255;
    return luminance < 0.5;
  } catch {
    return true;
  }
}

// Theme and mount are external state, not component state: reading them through
// useSyncExternalStore keeps the first paint stable and avoids a cascading
// render from setState inside an effect.
const subscribeTheme = (onStoreChange) => {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  observer.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
  return () => observer.disconnect();
};
const subscribeMounted = () => () => {};
const getMounted = () => true;
const getServerMounted = () => false;
const getServerDark = () => true;

function ValueLabel({ label, ultra }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.classList.remove("hf-glitch");
    void el.offsetWidth;
    el.classList.add("hf-glitch");
    const timer = setTimeout(() => el.classList.remove("hf-glitch"), 320);
    return () => clearTimeout(timer);
  }, [label]);
  return (
    <span ref={ref} className="hf-value" data-ultra={ultra ? "1" : "0"}>
      <span key={label} className="hf-value-inner">{label}</span>
    </span>
  );
}

export default function EffortSlider({ value = "high", onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, bottom: 0 });
  const [draft, setDraft] = useState(null);
  const [settings, setSettings] = useState(() => (typeof window === "undefined" ? DEFAULT_SETTINGS : readSettings()));
  const [tip, setTip] = useState(false);
  const [panel, setPanel] = useState(false);
  const [playSeq, setPlaySeq] = useState(0);
  const mounted = useSyncExternalStore(subscribeMounted, getMounted, getServerMounted);
  const dark = useSyncExternalStore(subscribeTheme, surfaceIsDark, getServerDark);
  // The parent persists asynchronously, so its `value` prop lands after
  // onChange. This keeps the just-picked stop on screen until then, which is
  // what stops the label and knob from snapping back and forward again.
  const [pending, setPending] = useState(null);
  const chipRef = useRef(null);
  const trackRef = useRef(null);
  const dragRef = useRef(false);
  const lastRef = useRef(-1);

  const index = Math.max(0, HYDRAFUSION_STOPS.findIndex((stop) => stop.key === value));
  const pendingKey = pending === null ? null : HYDRAFUSION_STOPS[pending]?.key;
  // Once the saved value arrives the optimistic stop is already redundant, so
  // it is ignored during render instead of being cleared from an effect.
  const optimistic = pending !== null && value !== pendingKey ? pending : null;
  const activeIndex = draft !== null ? draft : (optimistic !== null ? optimistic : index);
  const stop = HYDRAFUSION_STOPS[activeIndex] || HYDRAFUSION_STOPS[0];
  const ultra = stop?.ultra === true;
  const label = stop?.label || "High";

  const commit = useCallback((nextIndex) => {
    const next = HYDRAFUSION_STOPS[nextIndex];
    if (!next) return;
    const alreadySaved = next.key === value || next.key === pendingKey;
    if (!alreadySaved) {
      if (next.ultra) {
        lastPlayedKey = null;
        setPlaySeq((n) => n + 1);
      }
      setPending(nextIndex);
      onChange?.(next.key);
    }
    setDraft(null);
  }, [onChange, pendingKey, value]);

  // Release the optimistic stop after a while. The timeout only guards a
  // rejected save so a failed PATCH cannot pin the slider forever.
  useEffect(() => {
    if (pending === null) return undefined;
    const timer = setTimeout(() => setPending(null), 3000);
    return () => clearTimeout(timer);
  }, [pending]);

  const openAt = useCallback((element) => {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - POPOVER_W, window.innerWidth - POPOVER_W - 8));
    const bottom = window.innerHeight - rect.top + 10;
    setPos({ left, bottom });
    setOpen(true);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (event.target?.closest?.(".hf-pop") || event.target?.closest?.(".hf-chip")) return;
      setOpen(false);
    };
    const onKey = (event) => { if (event.key === "Escape") setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  const indexAt = (clientX) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return indexFromPct(pctFromX(clientX - rect.left), HYDRAFUSION_STOPS.length);
  };

  const onPointerDown = (event) => {
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    dragRef.current = true;
    const next = indexAt(event.clientX);
    lastRef.current = next;
    setDraft(next);
  };

  const onPointerMove = (event) => {
    if (!dragRef.current) return;
    const next = indexAt(event.clientX);
    if (next === lastRef.current) return;
    lastRef.current = next;
    setDraft(next);
  };

  const finish = (event) => {
    if (!dragRef.current) return;
    dragRef.current = false;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    const next = event.type === "pointercancel"
      ? (lastRef.current >= 0 ? lastRef.current : activeIndex)
      : indexAt(event.clientX);
    commit(next);
  };

  const onKeyDown = (event) => {
    let next = activeIndex;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, activeIndex - 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(HYDRAFUSION_STOPS.length - 1, activeIndex + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = HYDRAFUSION_STOPS.length - 1;
    else return;
    event.preventDefault();
    setDraft(next);
    commit(next);
  };

  const updateSettings = (next) => {
    const normalized = {
      ticks: next?.ticks === "hide" ? "hide" : "show",
      texture: next?.texture === "soft" ? "soft" : "normal",
    };
    setSettings(normalized);
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized)); } catch { /* ignore */ }
  };

  const pct = pctFromIndex(activeIndex, HYDRAFUSION_STOPS.length);
  const x = xForPct(pct);
  const ticks = HYDRAFUSION_STOPS.map((s, i) => ({
    key: s.key,
    left: xForPct(pctFromIndex(i, HYDRAFUSION_STOPS.length)),
    on: i <= activeIndex,
    last: i === HYDRAFUSION_STOPS.length - 1,
  }));

  const popover = open && mounted ? createPortal(
    <div
      className="hf-pop"
      data-dark={dark ? "1" : "0"}
      style={{ left: `${pos.left}px`, bottom: `${pos.bottom}px` }}
      role="group"
      aria-label="HydraFusion effort"
      onContextMenu={(event) => { event.preventDefault(); setPanel(true); }}
    >
      <div className="hf-head">
        <div className="hf-title">Effort<ValueLabel label={label} ultra={ultra} /></div>
        <button type="button" className="hf-help" aria-label="About effort" onClick={() => setTip((v) => !v)}>?</button>
      </div>
      {tip && (
        <div className="hf-tip">
          Higher tiers think longer and add independent eyes. Ultra runs at max thinking and lights the pixel band.
        </div>
      )}
      <div className="hf-labels"><span>Faster</span><span>Smarter</span></div>
      <div
        className="hf-track"
        ref={trackRef}
        data-ultra={ultra ? "1" : "0"}
        data-drag={draft !== null ? "1" : "0"}
        role="slider"
        tabIndex={0}
        aria-valuemin={0}
        aria-valuemax={HYDRAFUSION_STOPS.length - 1}
        aria-valuenow={activeIndex}
        aria-valuetext={label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finish}
        onPointerCancel={finish}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => { event.preventDefault(); setPanel(true); }}
      >
        <span className="hf-fill" style={{ width: ultra ? "100%" : `${x}px` }}>
          {/* Only mount the texture after release. Mounting it during the drag
              starts the sweep early, then commit bumps playSeq and restarts it
              from zero — the visible "all pixels, then replay" glitch. */}
          {ultra && draft === null && (
            <DitherCanvas
              dark={dark}
              opacity={settings.texture === "soft" ? 0.75 : 1}
              sweep
              animKey={stop.key}
              playSeq={playSeq}
            />
          )}
        </span>
        {ticks.map((tick) => (
          <span
            key={tick.key}
            className="hf-tick"
            data-on={tick.on ? "1" : "0"}
            data-last={tick.last ? "1" : "0"}
            style={{ left: `${tick.left}px`, display: settings.ticks === "hide" ? "none" : undefined }}
          />
        ))}
        <span className="hf-knob" style={{ left: `${x}px` }} />
      </div>
      {panel && (
        <div className="hf-set">
          <div className="hf-set-row">
            <span>Tick marks</span>
            <button type="button" className="hf-set-btn" onClick={() => updateSettings({ ...settings, ticks: settings.ticks === "hide" ? "show" : "hide" })}>
              {settings.ticks === "hide" ? "Hidden" : "Shown"}
            </button>
          </div>
          <div className="hf-set-row">
            <span>Texture</span>
            <button type="button" className="hf-set-btn" onClick={() => updateSettings({ ...settings, texture: settings.texture === "soft" ? "normal" : "soft" })}>
              {settings.texture === "soft" ? "Soft" : "Normal"}
            </button>
          </div>
        </div>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <style>{CSS}</style>
      <button
        ref={chipRef}
        type="button"
        className="hf-chip"
        data-ultra={ultra ? "1" : "0"}
        data-dark={dark ? "1" : "0"}
        title={`HydraFusion effort: ${label}`}
        disabled={disabled}
        onClick={(event) => {
          event.preventDefault();
          if (open) { setOpen(false); return; }
          openAt(event.currentTarget);
        }}
      >
        {label}
      </button>
      {popover}
    </>
  );
}
