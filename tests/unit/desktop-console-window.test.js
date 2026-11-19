// Desktop console launcher — the tray items that open a live log.
//
// The three tray menu entries ("Open Gateway Console", "Open Panda
// Orchestrator Console", "Restart Panda Orchestrator") all ended up calling
// `spawn(powershell, { detached: true })`, which on Windows maps to
// DETACHED_PROCESS: no console, no window, exit 0. Every click looked like a
// dead menu item. The fix is `cmd /c start <title> powershell -File <ps1>`,
// and these tests pin the pieces that must not regress:
//   - the launcher is cmd, not a detached child
//   - `start` gets a title before the program
//   - the script decodes AND renders UTF-8 (the "ðŸ’¡" mojibake report)
//   - PowerShell single-quoted literals are escaped (`'` → `''`)
//
// Pure string/argument assertions: no window is opened, no process is spawned.
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { consoleScript, launchSpec, powershellPath, psLiteral, scriptPathFor } = require("../../desktop/consoleWindow.cjs");

describe("desktop console launcher", () => {
  it("launches through cmd /c start so a real console window exists", () => {
    const spec = launchSpec("C:\\logs\\router.log", "OriginRouter gateway console");
    expect(spec.command.toLowerCase()).toContain("cmd.exe");
    expect(spec.args[0]).toBe("/c");
    expect(spec.args[1]).toBe("start");
    expect(spec.args[2]).toBe("OriginRouter gateway console"); // title comes first
    expect(spec.args[3]).toBe(powershellPath());
    expect(spec.args).toContain("-File");
    expect(spec.args.at(-1)).toBe(spec.scriptPath);
    // A detached PowerShell is exactly the bug this replaced.
    expect(spec.args.join(" ")).not.toContain("-Command");
  });

  it("puts one stable helper next to the log, named after it", () => {
    expect(scriptPathFor("C:\\Users\\me\\.or\\logs\\router.log")).toBe(
      "C:\\Users\\me\\.or\\logs\\router-console.ps1",
    );
    expect(scriptPathFor("C:\\logs\\panda.err.log")).toBe("C:\\logs\\panda.err-console.ps1");
  });

  it("waits for a missing log instead of closing the window", () => {
    const script = consoleScript("C:\\logs\\router.log");
    expect(script).toContain("Test-Path 'C:\\logs\\router.log'");
    expect(script).toContain("Start-Sleep");
    expect(script).toContain("-Wait");
  });

  it("decodes the log as UTF-8 AND renders UTF-8 in the console", () => {
    const script = consoleScript("C:\\logs\\router.log");
    // Reading with the ANSI default turned "💡" into "ðŸ’¡".
    expect(script).toContain("Get-Content 'C:\\logs\\router.log' -Encoding UTF8");
    // PowerShell 5's console writer defaults to the OEM code page too.
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8");
  });

  it("escapes PowerShell single-quoted literals (a quote is data, not code)", () => {
    expect(psLiteral("C:\\it's here\\router.log")).toBe("'C:\\it''s here\\router.log'");
    expect(psLiteral("plain")).toBe("'plain'");
    const script = consoleScript("C:\\it's here\\router.log");
    expect(script).toContain("'C:\\it''s here\\router.log'");
  });
});
