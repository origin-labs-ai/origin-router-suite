import fs from "node:fs";
import path from "node:path";

// The packaged builds drop an install.json next to the app. The portable
// folder carries mode "portable", the installer carries mode "installer".
// A source checkout has neither.
export function readInstallInfo() {
  const candidates = [
    path.join(process.cwd(), "install.json"),
    path.join(process.cwd(), "app", "install.json"),
    path.join(process.cwd(), "..", "install.json"),
    path.join(process.cwd(), "..", "..", "install.json"),
  ];
  for (const file of candidates) {
    try {
      const info = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (info && typeof info.mode === "string") return { ...info, path: file };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

export function isPortableInstall() {
  return readInstallInfo()?.mode === "portable";
}
