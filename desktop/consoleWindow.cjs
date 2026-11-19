"use strict";

// Opening a live log in its own console window.
//
// `spawn(powershell, ..., { detached: true })` looks like the obvious way to
// do this and silently does nothing: libuv maps the detached flag to
// DETACHED_PROCESS on Windows, so the child starts without a console and the
// window it was supposed to show never exists. Every tray item that opens a
// console (gateway log, Panda log, restart Panda) went through that call, so
// all three looked dead no matter how often they were clicked.
//
// `cmd /c start` is the part that actually creates the console. The tail loop
// lives in a .ps1 file next to the log, so no user path or window title has to
// survive two levels of command-line quoting.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function powershellPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function commandPromptPath() {
  return (
    process.env.ComSpec ||
    path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "cmd.exe")
  );
}

// PowerShell single-quoted literal: the only escape inside one is '' for a
// quote. Log paths are local data, never a command line fragment, but the
// quoting still has to be exact — a stray quote would turn the path into code.
function psLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// What the console runs: wait for the log if it is not there yet, then follow
// it. -Tail seeds the window with recent history instead of an empty screen;
// -Wait keeps it alive until the user closes the window.
function consoleScript(file) {
  return [
    // Decode AND render UTF-8. The gateway writes UTF-8, Windows PowerShell
    // defaults to the ANSI code page on read, and the console host itself
    // defaults to it on write — get either wrong and an emoji or a non-ASCII
    // name shows up as "ðŸ’¡". Both sides are pinned here.
    `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}`,
    `while (-not (Test-Path ${psLiteral(file)})) { Start-Sleep -Seconds 1 }`,
    `Get-Content ${psLiteral(file)} -Encoding UTF8 -Tail 300 -Wait`,
  ].join("\n");
}

// One stable helper per log file (router.log → router-console.ps1) in the same
// folder, so repeated clicks reuse the file instead of piling up temp scripts.
function scriptPathFor(file) {
  const base = path.basename(file, path.extname(file));
  return path.join(path.dirname(file), `${base}-console.ps1`);
}

// `start` reads its first quoted argument as the window title, then launches
// the program. Exposed as data so the tests can pin the shape without opening
// a window.
function launchSpec(file, title) {
  const scriptPath = scriptPathFor(file);
  return {
    scriptPath,
    command: commandPromptPath(),
    args: [
      "/c",
      "start",
      title,
      powershellPath(),
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ],
  };
}

/**
 * Open (or re-focus) a console window that follows `file`.
 *
 * @param {{file:string,title:string,onFallback?:Function,spawnImpl?:Function,fsImpl?:object}} opts
 * @returns {boolean} whether the launcher was started
 */
function openConsoleWindow({ file, title, onFallback, spawnImpl = spawn, fsImpl = fs }) {
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    if (!fsImpl.existsSync(file)) fsImpl.writeFileSync(file, "", "utf8");
    const spec = launchSpec(file, title);
    fsImpl.writeFileSync(spec.scriptPath, consoleScript(file), "utf8");
    const child = spawnImpl(spec.command, spec.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.on("error", () => onFallback?.());
    child.unref();
    return true;
  } catch {
    onFallback?.();
    return false;
  }
}

module.exports = {
  consoleScript,
  launchSpec,
  openConsoleWindow,
  powershellPath,
  psLiteral,
  scriptPathFor,
};
