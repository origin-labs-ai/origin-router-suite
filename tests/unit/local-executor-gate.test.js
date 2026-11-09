// Local-executor gate — the opt-in switch that keeps providers which run a
// program on this machine (devin-cli) off by default, in BOTH directions:
// the provider card and the /v1 route. Tests pin the rule, the fail-closed
// direction, and that ordinary providers are never affected.
import { describe, expect, it } from "vitest";
import {
  isLocalExecutor,
  isLocalExecutorEnabled,
  LOCAL_EXECUTOR_FLAGS,
} from "../../open-sse/config/localExecutors.js";
import {
  providerIdForModel,
  isLocalExecutorBlocked,
  localExecutorDeniedResponse,
} from "../../src/sse/services/localExecutorGate.js";
import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";

const OFF = { localExecutors: { devinCli: false } };
const ON = { localExecutors: { devinCli: true } };

describe("local executor flags", () => {
  it("knows which providers execute local programs", () => {
    expect(isLocalExecutor("devin-cli")).toBe(true);
    expect(isLocalExecutor("claude")).toBe(false);
    expect(isLocalExecutor("")).toBe(false);
    expect(isLocalExecutor(undefined)).toBe(false);
    // One provider per flag; the settings key is what the UI persists.
    expect(LOCAL_EXECUTOR_FLAGS["devin-cli"]).toBe("devinCli");
  });

  it("fails closed: anything but a literal true is OFF", () => {
    expect(isLocalExecutorEnabled(OFF, "devin-cli")).toBe(false);
    expect(isLocalExecutorEnabled(undefined, "devin-cli")).toBe(false);
    expect(isLocalExecutorEnabled({}, "devin-cli")).toBe(false);
    expect(isLocalExecutorEnabled({ localExecutors: {} }, "devin-cli")).toBe(false);
    // A string "true" from a hand-edited settings file must not open the gate.
    expect(isLocalExecutorEnabled({ localExecutors: { devinCli: "true" } }, "devin-cli")).toBe(false);
    expect(isLocalExecutorEnabled(ON, "devin-cli")).toBe(true);
  });

  it("never gates a provider that is not a local executor", () => {
    expect(isLocalExecutorEnabled(OFF, "claude")).toBe(true);
    expect(isLocalExecutorEnabled({}, "openai")).toBe(true);
  });

  it("defaults a fresh install to OFF", () => {
    expect(mergeWithDefaults({}).localExecutors).toEqual({ devinCli: false });
    // A partial write of another key must not drop the switch.
    expect(mergeWithDefaults({ localExecutors: { devinCli: true }, theme: "dark" }).localExecutors)
      .toEqual({ devinCli: true });
  });
});

describe("model → provider resolution for the gate", () => {
  it("resolves the id, the alias and the bare alias", () => {
    expect(providerIdForModel("devin-cli/swe-1.6")).toBe("devin-cli");
    expect(providerIdForModel("dv/swe-1.6")).toBe("devin-cli");
    expect(providerIdForModel("devin/swe-1.6")).toBe("devin-cli");
    expect(providerIdForModel("devin")).toBe("devin-cli");
  });

  it("returns null for junk instead of guessing", () => {
    expect(providerIdForModel("")).toBeNull();
    expect(providerIdForModel(undefined)).toBeNull();
  });
});

describe("blocking a request", () => {
  it("blocks devin-cli while the switch is off — every spelling", () => {
    for (const model of ["devin-cli/swe-1.6", "dv/swe-1.6", "devin/swe-1.6"]) {
      expect(isLocalExecutorBlocked(OFF, model), model).toBe(true);
      expect(isLocalExecutorBlocked(undefined, model), model).toBe(true);
    }
  });

  it("allows it once the switch is on, and never touches other providers", () => {
    expect(isLocalExecutorBlocked(ON, "devin-cli/swe-1.6")).toBe(false);
    expect(isLocalExecutorBlocked(OFF, "claude/sonnet")).toBe(false);
    expect(isLocalExecutorBlocked(OFF, "openai/gpt-5")).toBe(false);
  });

  it("answers 403 (not 401/404) so a client knows it is switched off, not broken", async () => {
    const denied = localExecutorDeniedResponse(OFF, "devin-cli/swe-1.6");
    expect(denied).toBeTruthy();
    expect(denied.status).toBe(403);
    const body = await denied.json();
    expect(body.error.code).toBe("local_executor_disabled");
    expect(body.error.message).toContain("Local executor providers");
  });

  it("returns null when the provider is allowed", () => {
    expect(localExecutorDeniedResponse(ON, "devin-cli/swe-1.6")).toBeNull();
    expect(localExecutorDeniedResponse(OFF, "claude/sonnet")).toBeNull();
  });

  it("filters a combo that still lists a disabled member", () => {
    const members = ["claude/sonnet", "devin-cli/swe-1.6", "openai/gpt-5"];
    const usable = members.filter((m) => !isLocalExecutorBlocked(OFF, m));
    expect(usable).toEqual(["claude/sonnet", "openai/gpt-5"]);
    // With the switch on the member comes back — no combo edit needed.
    expect(members.filter((m) => !isLocalExecutorBlocked(ON, m))).toEqual(members);
  });
});
