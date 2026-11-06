// Docker LAN-gate fix: the host's published-port traffic reaches the container
// as the bridge gateway, and that address has to count as "this computer".
// Otherwise the image answers 403 to the host — including its own health check.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let routeFileContent = "";
const readFileSync = vi.fn(() => routeFileContent);

vi.mock("node:fs", () => ({
  default: { readFileSync },
  readFileSync,
}));

const ROUTE_TABLE = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "eth0\t00000000\t0101A8C0\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  "eth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0",
  "",
].join("\n");

const BRIDGE_TABLE = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "eth0\t00000000\t010011AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
  "",
].join("\n");

async function loadModule({ container = true, platform = "linux" } = {}) {
  vi.resetModules();
  if (container) process.env.OR_CONTAINER = "1";
  else delete process.env.OR_CONTAINER;
  const originalPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  const mod = await import("../../src/lib/containerNetwork.js");
  return { mod, restorePlatform: () => Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true }) };
}

describe("containerNetwork - container gateway detection", () => {
  beforeEach(() => {
    readFileSync.mockClear();
    routeFileContent = ROUTE_TABLE;
  });

  afterEach(() => {
    delete process.env.OR_CONTAINER;
  });

  it("ignores /proc/net/route entirely outside a container", async () => {
    const { mod, restorePlatform } = await loadModule({ container: false });
    expect(mod.getContainerGatewayIp()).toBeNull();
    expect(mod.isContainerGateway("192.168.1.1")).toBe(false);
    expect(readFileSync).not.toHaveBeenCalled();
    restorePlatform();
  });

  it("ignores /proc/net/route on a non-Linux host", async () => {
    const { mod, restorePlatform } = await loadModule({ container: true, platform: "darwin" });
    expect(mod.getContainerGatewayIp()).toBeNull();
    expect(readFileSync).not.toHaveBeenCalled();
    restorePlatform();
  });

  it("reads the default-route gateway from /proc/net/route", async () => {
    const { mod, restorePlatform } = await loadModule();
    expect(mod.getContainerGatewayIp()).toBe("192.168.1.1");
    expect(readFileSync).toHaveBeenCalledWith("/proc/net/route", "utf8");
    restorePlatform();
  });

  it("reads the Docker default bridge gateway 172.17.0.1", async () => {
    routeFileContent = BRIDGE_TABLE;
    const { mod, restorePlatform } = await loadModule();
    expect(mod.getContainerGatewayIp()).toBe("172.17.0.1");
    restorePlatform();
  });

  it("treats the gateway as this computer and nothing else", async () => {
    const { mod, restorePlatform } = await loadModule();
    expect(mod.isContainerGateway("192.168.1.1")).toBe(true);
    expect(mod.isContainerGateway("::ffff:192.168.1.1")).toBe(true);
    expect(mod.isContainerGateway("192.168.1.50")).toBe(false);
    expect(mod.isContainerGateway("127.0.0.1")).toBe(false);
    expect(mod.isContainerGateway("")).toBe(false);
    restorePlatform();
  });

  it("returns null when the route table has no default route", async () => {
    routeFileContent = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\neth0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n";
    const { mod, restorePlatform } = await loadModule();
    expect(mod.getContainerGatewayIp()).toBeNull();
    expect(mod.isContainerGateway("172.17.0.1")).toBe(false);
    restorePlatform();
  });

  it("returns null when the route table cannot be read", async () => {
    readFileSync.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });
    const { mod, restorePlatform } = await loadModule();
    expect(mod.getContainerGatewayIp()).toBeNull();
    restorePlatform();
  });
});
