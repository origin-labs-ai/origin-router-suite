"use strict";

// First-run question for the portable build: should OriginRouter start in the
// system tray, or stay in the foreground with its console window?
//
// The installer already owns that decision (it has a task for it), so the
// question only shows up in the portable zip, where there is no installer to
// ask. The answer is remembered, so it is asked exactly once.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const QUESTION = "Minimize OriginRouter to the system tray?";

function preferenceFile() {
  // The override exists so the behaviour can be tested without touching the
  // real profile, and so a portable build on a locked-down machine can point
  // the answer somewhere writable.
  const override = process.env.ORIGINROUTER_TRAY_PREFERENCE;
  if (override) return override;
  return path.join(os.homedir(), ".or", "tray-preference.json");
}

function readPreference() {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferenceFile(), "utf8"));
    if (parsed && typeof parsed.tray === "boolean") return parsed.tray;
  } catch {
    // No preference yet, or the file is unreadable.
  }
  return null;
}

function writePreference(tray) {
  try {
    fs.mkdirSync(path.dirname(preferenceFile()), { recursive: true });
    fs.writeFileSync(preferenceFile(), JSON.stringify({ tray }, null, 2), "utf8");
  } catch {
    // A preference we cannot store is not worth failing the launch over.
  }
}

// Windows: a real message box, so the answer is visible even when the CLI was
// started from a shortcut with no console.
function askWindows() {
  const script = [
    "$ws = New-Object -ComObject WScript.Shell",
    `$r = $ws.Popup('${QUESTION}', 0, 'OriginRouter', 4)`,
    "if ($r -eq 6) { exit 0 } else { exit 1 }",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true, timeout: 120000 }
  );
  if (result.error || result.status === null) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

// macOS: the standard "display dialog" button sheet.
function askMac() {
  const script = `display dialog "${QUESTION}" buttons {"No", "Yes"} default button "Yes"`;
  const result = spawnSync("osascript", ["-e", script], { timeout: 120000 });
  if (result.error || result.status === null) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

// Linux: zenity when it is installed, otherwise nothing.
function askLinux() {
  const result = spawnSync(
    "zenity",
    ["--question", "--title", "OriginRouter", "--text", QUESTION, "--ok-label", "Yes", "--cancel-label", "No"],
    { timeout: 120000 }
  );
  if (result.error || result.status === null) return null;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  return null;
}

// Last resort: the terminal. Only asked when there is a terminal to ask in.
function askTerminal() {
  if (!process.stdin.isTTY) return null;
  try {
    const readline = require("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = rl.question(`${QUESTION} [Y/n] `, (value) => {
      rl.close();
    });
    rl.close();
    const normalized = String(answer || "").trim().toLowerCase();
    if (!normalized) return true;
    return normalized === "y" || normalized === "yes";
  } catch {
    return null;
  }
}

/**
 * Ask the question with the best dialog the platform offers.
 * Returns true for tray, false for foreground, null when nobody answered.
 */
function askTrayPreference() {
  let answer = null;
  if (process.platform === "win32") answer = askWindows();
  else if (process.platform === "darwin") answer = askMac();
  else answer = askLinux();
  if (answer === null) answer = askTerminal();
  return answer;
}

/**
 * The tray preference for a portable install: the remembered answer, or a
 * fresh question. Returns null when the user has to be asked and did not
 * answer - the caller then leaves the foreground mode alone.
 */
function resolveTrayPreference({ ask = true } = {}) {
  const stored = readPreference();
  if (stored !== null) return stored;
  if (!ask) return null;
  const answer = askTrayPreference();
  if (answer === null) return null;
  writePreference(answer);
  return answer;
}

module.exports = { askTrayPreference, resolveTrayPreference, readPreference, QUESTION };
