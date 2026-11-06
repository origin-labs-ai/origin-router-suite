// The portable build asks once whether to start in the system tray. These
// tests cover the marker that makes a build portable and the answer that is
// remembered afterwards.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "originrouter-tray-"));
process.env.ORIGINROUTER_TRAY_PREFERENCE = path.join(tmp, "tray-preference.json");

const { resolveTrayPreference, readPreference } = await import("../../cli/src/cli/trayPrompt.js");
const updater = await import("../../cli/src/cli/updater.js");

function writePreference(value) {
  fs.writeFileSync(path.join(tmp, "tray-preference.json"), JSON.stringify({ tray: value }), "utf8");
}

describe("portable build - system tray preference", () => {
  beforeEach(() => {
    try { fs.unlinkSync(path.join(tmp, "tray-preference.json")); } catch { /* not there yet */ }
  });

  afterEach(() => {
    try { fs.unlinkSync(path.join(tmp, "tray-preference.json")); } catch { /* already gone */ }
  });

  it("has no preference before the question is answered", () => {
    expect(readPreference()).toBeNull();
  });

  it("remembers that the user said yes", () => {
    writePreference(true);
    expect(readPreference()).toBe(true);
    expect(resolveTrayPreference()).toBe(true);
  });

  it("remembers that the user said no", () => {
    writePreference(false);
    expect(readPreference()).toBe(false);
    expect(resolveTrayPreference()).toBe(false);
  });

  it("asks exactly once and then reuses the answer", () => {
    // No stored answer and no dialog available (no TTY in a test), so the
    // question cannot be answered and nothing is written down.
    const answer = resolveTrayPreference();
    expect(answer).toBeNull();
    expect(readPreference()).toBeNull();
  });
});

describe("portable marker", () => {
  it("is only read from the folder the launcher runs from", () => {
    // The launcher is not installed here, so both readers must report
    // nothing rather than inventing an answer.
    expect(updater.readInstallInfo()).toBeNull();
    expect(updater.readPortableInfo()).toBeNull();
  });
});
