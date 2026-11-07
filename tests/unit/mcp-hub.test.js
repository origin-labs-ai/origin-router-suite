// MCP Hub tests — URL guard, config toggles, disabled-state fail-open.
import { describe, it, expect } from "vitest";
import {
  assertSafeUrl,
  resolveHubConfig,
  listExternalTools,
  callExternalTool,
  hubStatus,
  MCP_HUB_DEFAULTS,
} from "../../src/lib/mcp/hub.js";

describe("mcp hub url guard", () => {
  it("allows https anywhere and http only on loopback", () => {
    expect(assertSafeUrl("http://127.0.0.1:7800").hostname).toBe("127.0.0.1");
    expect(assertSafeUrl("http://localhost:7800").hostname).toBe("localhost");
    expect(assertSafeUrl("https://mcp.example.com").protocol).toBe("https:");
    // Private ranges are refused before the loopback rule, so 10.x reports
    // the private-range reason.
    expect(() => assertSafeUrl("http://10.0.0.5:7800")).toThrow(/private-range/);
    expect(() => assertSafeUrl("http://192.168.1.9:7800")).toThrow(/private-range/);
    expect(() => assertSafeUrl("ftp://x")).toThrow(/http/);
    expect(() => assertSafeUrl("not a url")).toThrow(/invalid/);
  });
});

describe("mcp hub config", () => {
  it("resolves enabled servers from the id allowlist only", () => {
    const cfg = resolveHubConfig({ mcpHub: { enabled: true, enabledServers: ["rea"] } });
    expect(cfg.enabled).toBe(true);
    expect(cfg.servers.map((s) => s.id)).toEqual(["rea"]);
    // Unknown ids can never enable anything — the default set is code-defined.
    expect(resolveHubConfig({ mcpHub: { enabled: true, enabledServers: ["evil-server"] } }).servers).toEqual([]);
  });

  it("defaults to disabled with the REA entry dormant", () => {
    const cfg = resolveHubConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.servers).toEqual([]);
    expect(MCP_HUB_DEFAULTS.servers.some((s) => s.id === "rea")).toBe(true);
  });
});

describe("mcp hub fail-open", () => {
  it("disabled hub returns zero tools and refuses calls", async () => {
    const { tools } = await listExternalTools({});
    expect(tools).toEqual([]);
    const out = await callExternalTool({}, "rea:open_binary", {});
    expect(out.ok).toBe(false);
    expect(out.error).toContain("disabled");
  });

  it("an unreachable enabled server yields zero tools + an error line, never a throw", async () => {
    const settings = { mcpHub: { enabled: true, enabledServers: ["rea"] } };
    const { tools, errors } = await listExternalTools(settings);
    expect(tools).toEqual([]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("rea:");
  });

  it("hubStatus reports the catalog and enable flags", () => {
    const st = hubStatus({ mcpHub: { enabled: true, enabledServers: ["rea"] } });
    expect(st.enabled).toBe(true);
    expect(st.defaults[0].id).toBe("rea");
    expect(st.servers[0].id).toBe("rea");
  });
});
