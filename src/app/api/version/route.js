import https from "https";
import pkg from "../../../../package.json" with { type: "json" };
import { UPDATER_CONFIG } from "@/shared/constants/config";

const VERSION_CACHE_TTL_MS = 3600000; // cache the release lookup for 1h

// Survive hot reload; one cache per process
const versionCache = (global.__releaseVersionCache ??= { value: null, fetchedAt: 0 });

// The latest published version, from the release the app actually updates from.
// This used to ask the npm registry for a package that has never been published,
// which made the answer permanently "unknown" - and the sidebar's update banner
// then told people to run `npm i -g` for software that does not exist there.
function fetchLatestVersion() {
  return new Promise((resolve) => {
    const req = https.get(
      UPDATER_CONFIG.releasesApiUrl,
      { timeout: 4000, headers: { "User-Agent": "originrouter-version-check", Accept: "application/vnd.github+json" } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const tag = JSON.parse(data)?.tag_name || "";
            resolve(tag ? tag.replace(/^v/, "") : null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

async function getLatestVersionCached() {
  if (versionCache.value && Date.now() - versionCache.fetchedAt < VERSION_CACHE_TTL_MS) {
    return versionCache.value;
  }
  const latest = await fetchLatestVersion();
  if (latest) {
    versionCache.value = latest;
    versionCache.fetchedAt = Date.now();
  }
  return latest;
}

export async function GET() {
  const latestVersion = await getLatestVersionCached();
  const currentVersion = pkg.version;
  const hasUpdate = latestVersion ? compareVersions(latestVersion, currentVersion) > 0 : false;

  return Response.json({ currentVersion, latestVersion, hasUpdate });
}
