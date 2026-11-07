// Local model search — find models the user can pull onto their machine.
//
// Two upstream catalogs are searched:
//   • Hugging Face  — official JSON API (https://huggingface.co/api/models)
//   • Ollama        — the public library page (https://ollama.com/library),
//                     parsed lightly from HTML because Ollama ships no
//                     official search API.
//
// SECURITY: unlike the engine probes (deliberate 127.0.0.1 exception), these
// are genuine outbound requests. Both go through the repo SSRF guard
// (fetchPublic: https, DNS-resolved non-loopback, redirect-safe) AND a strict
// per-source host allowlist — a "result" can never trick us into fetching from
// somewhere else, and neither can a redirected CDN hop to a private address.
//
// Fail-open contract: a dead or redesigned upstream returns an empty list plus
// a `note` for the UI — searching must never throw into the dashboard.

import { fetchPublic, assertPublicUrl } from "@/shared/utils/ssrfGuard.js";

// The only hosts each source may ever talk to. Exact host match after URL
// parsing, so "https://evil-huggingface.co" or subdomain tricks fail the check.
export const HF_ALLOWED_HOSTS = new Set(["huggingface.co"]);
export const OLLAMA_ALLOWED_HOSTS = new Set(["ollama.com"]);

// Shared cap on result rows — keeps both the HTML parse and the JSON path
// from ever returning an unbounded list to render.
const MAX_RESULTS = 30;

// Validate a URL for a given source: https protocol + exact allowlisted host.
// Returns the parsed URL or null (callers treat null as "skip this candidate").
function parseAllowedUrl(rawUrl, allowedHosts) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:") return null;
    if (!allowedHosts.has(parsed.hostname.toLowerCase())) return null;
    // Second opinion from the SSRF guard — it also normalizes hostile
    // representations (trailing dots, IPv4-mapped IPv6, etc.) that a naive
    // string comparison above might miss.
    assertPublicUrl(parsed.toString());
    return parsed;
  } catch {
    return null;
  }
}

// Read the HF token without ever crashing the search. The token is optional —
// it only lifts anonymous rate limits on api.huggingface.co — and comes from
// the settings store (user-entered in the dashboard) or the environment. No
// credential is ever hard-coded here, and a broken DB must not break search.
async function readHfToken() {
  try {
    const { getSettings } = await import("@/lib/db/index.js");
    const settings = await getSettings();
    if (typeof settings?.huggingfaceToken === "string" && settings.huggingfaceToken.trim()) {
      return settings.huggingfaceToken.trim();
    }
  } catch {
    // Settings store unavailable — fall through to the environment below.
  }
  const envToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN;
  return typeof envToken === "string" && envToken.trim() ? envToken.trim() : null;
}

// Search Hugging Face via the public models API.
// Normalized rows: { source, id, author, downloads, likes, pipelineTag, lastModified, tags }
export async function searchHuggingFace(query, { limit = 20 } = {}) {
  const note = null;
  try {
    const q = typeof query === "string" ? query.trim() : "";
    if (!q) return { source: "huggingface", results: [], note };

    const capped = Math.max(1, Math.min(Number(limit) || 20, MAX_RESULTS));
    const url = new URL("https://huggingface.co/api/models");
    url.searchParams.set("search", q);
    url.searchParams.set("limit", String(capped));

    // The allowlist check re-derives from the string URL, guarding against the
    // URL object being tampered with between build and send.
    if (!parseAllowedUrl(url.toString(), HF_ALLOWED_HOSTS)) {
      return { source: "huggingface", results: [], note: "Blocked non-HTTPS or non-Hugging Face request." };
    }

    const headers = { Accept: "application/json" };
    const token = await readHfToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetchPublic(url.toString(), { headers });
    if (!res.ok) {
      return { source: "huggingface", results: [], note: `Hugging Face API responded ${res.status}.` };
    }
    const rows = await res.json();
    if (!Array.isArray(rows)) {
      return { source: "huggingface", results: [], note: "Unexpected Hugging Face response shape." };
    }

    return {
      source: "huggingface",
      results: rows.slice(0, capped).map((row) => ({
        source: "huggingface",
        id: typeof row?.id === "string" ? row.id : "",
        author: typeof row?.author === "string" ? row.author : null,
        downloads: Number.isFinite(Number(row?.downloads)) ? Number(row.downloads) : 0,
        likes: Number.isFinite(Number(row?.likes)) ? Number(row.likes) : 0,
        pipelineTag: typeof row?.pipeline_tag === "string" ? row.pipeline_tag : null,
        lastModified: typeof row?.lastModified === "string" ? row.lastModified : null,
        tags: Array.isArray(row?.tags) ? row.tags.filter((t) => typeof t === "string").slice(0, 8) : [],
      })).filter((row) => row.id),
    };
  } catch (err) {
    // Fail-open: upstream unreachable, DNS dead, rate limited — all degrade to
    // "no results + a note", never an exception into the route handler.
    return { source: "huggingface", results: [], note: `Hugging Face search failed: ${err?.message || err}` };
  }
}

// Curated fallback: the well-known Ollama families, used whenever the library
// page cannot be fetched or parsed. Hard-coded, so this path never touches the
// network and can never break because the page markup changed.
export const OLLAMA_CURATED = [
  { id: "llama3", description: "Meta Llama 3 family", sizes: ["8B", "70B"] },
  { id: "qwen2.5", description: "Alibaba Qwen 2.5 general models", sizes: ["0.5B", "7B", "14B", "32B", "72B"] },
  { id: "qwen2.5-coder", description: "Qwen 2.5 code-specialized models", sizes: ["1.5B", "7B", "14B", "32B"] },
  { id: "deepseek-r1", description: "DeepSeek R1 reasoning models", sizes: ["7B", "8B", "14B", "32B", "70B"] },
  { id: "mistral", description: "Mistral 7B and friends", sizes: ["7B"] },
  { id: "gemma2", description: "Google Gemma 2 family", sizes: ["2B", "9B", "27B"] },
  { id: "phi4", description: "Microsoft Phi-4 small-but-mighty models", sizes: ["14B"] },
  { id: "llava", description: "Multimodal vision + language models", sizes: ["7B", "13B", "34B"] },
];

// Light HTML parse of https://ollama.com/library. The page links each model as
// href="/library/<name>"; descriptions and size chips sit in sibling markup.
// We extract what survives any given redesign and simply omit what does not —
// a row with only `id` is still useful, because the Download button just needs
// the model name for `ollama pull`.
function parseOllamaLibraryHtml(html) {
  const results = [];
  const seen = new Set();
  // Anchor match first: /library/<name> where name is URL-safe slug chars.
  const anchorRegex = /href="\/library\/([a-z0-9][a-z0-9.\-_]*)"/g;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);

    // Look ahead a small window after the anchor for the description paragraph
    // and size chips. Both are optional matches — markup changes degrade the
    // row instead of failing the whole parse.
    const window = html.slice(match.index, match.index + 1200);
    const descMatch = window.match(/<p[^>]*>([^<]{15,300})<\/p>/);
    const sizeMatches = [...window.matchAll(/>([0-9.]+[KMB]\b(?:\s*x[^<]*)?)</g)].map((m) => m[1]).slice(0, 6);

    results.push({
      source: "ollama",
      id,
      author: "ollama",
      description: descMatch ? descMatch[1].trim() : null,
      sizes: sizeMatches,
    });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

// Search the Ollama library. Fetch + light parse; on any failure, fall back to
// the curated families and say so in `note` so the UI can explain the downgrade.
export async function searchOllamaLibrary(query, { limit = 20 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 20, MAX_RESULTS));
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";

  try {
    const url = new URL("https://ollama.com/library");
    if (!parseAllowedUrl(url.toString(), OLLAMA_ALLOWED_HOSTS)) {
      return { source: "ollama", results: curatedRows(OLLAMA_CURATED, q, capped), note: "Blocked non-HTTPS or non-Ollama request; showing curated list." };
    }

    const res = await fetchPublic(url.toString(), { headers: { Accept: "text/html" } });
    if (!res.ok) {
      return { source: "ollama", results: curatedRows(OLLAMA_CURATED, q, capped), note: `Ollama library responded ${res.status}; showing curated list.` };
    }
    const html = await res.text();
    const parsed = parseOllamaLibraryHtml(html);
    if (!parsed.length) {
      return { source: "ollama", results: curatedRows(OLLAMA_CURATED, q, capped), note: "Could not parse the Ollama library page; showing curated list." };
    }
    // Filter client-side: the library page has no query parameter we can trust.
    const filtered = q ? parsed.filter((row) => row.id.includes(q) || (row.description || "").toLowerCase().includes(q)) : parsed;
    return { source: "ollama", results: (q ? filtered : parsed).slice(0, capped) };
  } catch (err) {
    return { source: "ollama", results: curatedRows(OLLAMA_CURATED, q, capped), note: `Ollama library search failed (${err?.message || err}); showing curated list.` };
  }
}

// Project the curated families into the same row shape the live parse emits,
// applying the same lowercase substring filter.
function curatedRows(curated, q, capped) {
  const rows = curated.map((entry) => ({
    source: "ollama",
    id: entry.id,
    author: "ollama",
    description: entry.description,
    sizes: entry.sizes,
  }));
  const filtered = q ? rows.filter((row) => row.id.includes(q) || (row.description || "").toLowerCase().includes(q)) : rows;
  return filtered.slice(0, capped);
}

// Unified search: ask both catalogs concurrently and interleave their rows,
// keeping each row tagged with its source so the UI can badge them. One
// catalog failing costs only its own half of the results. Rows are ordered
// best-first within each source (HF: downloads, already ranked by the API;
// Ollama: page order), interleaved so neither source drowns the other out.
export async function searchLocal(query, { limit = 20 } = {}) {
  const [hf, ollama] = await Promise.all([
    searchHuggingFace(query, { limit }),
    searchOllamaLibrary(query, { limit }),
  ]);

  // Round-robin merge: hf[0], ollama[0], hf[1], ollama[1], ... — up to `limit`.
  const merged = [];
  const max = Math.max(hf.results.length, ollama.results.length);
  for (let i = 0; i < max && merged.length < limit; i++) {
    if (hf.results[i]) merged.push(hf.results[i]);
    if (ollama.results[i] && merged.length < limit) merged.push(ollama.results[i]);
  }

  return {
    query,
    results: merged,
    notes: [hf.note, ollama.note].filter(Boolean),
  };
}
