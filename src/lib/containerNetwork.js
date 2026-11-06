// Container-aware peer classification.
//
// A published Docker port reaches the container through the bridge: the host's
// own connection is NAT-ed to the container's default gateway (172.17.0.1 on a
// default bridge), while a device on the LAN keeps its real address. The LAN
// gate has to treat that gateway as "this computer" — otherwise the image
// answers 403 to everything the host sends, including its own health check,
// and the dashboard can never be opened to switch LAN access on.
//
// Only consulted when the image sets OR_CONTAINER=1 (see Dockerfile). On a
// native Linux host the default gateway is the router, and treating the router
// as local would hand the dashboard to the whole network.
import fs from "node:fs";

// undefined = not probed yet, null = no usable gateway, string = IPv4 address.
let cachedGateway;

function hexToIpv4(hex) {
  const value = Number.parseInt(hex, 16);
  if (!Number.isFinite(value)) return null;
  return [
    value & 0xff,
    (value >> 8) & 0xff,
    (value >> 16) & 0xff,
    (value >> 24) & 0xff,
  ].join(".");
}

/**
 * IPv4 of the container's default route gateway — i.e. the Docker bridge peer
 * that stands in for the host machine. Null when we are not in a container.
 */
export function getContainerGatewayIp() {
  if (cachedGateway !== undefined) return cachedGateway;
  cachedGateway = null;
  if (process.env.OR_CONTAINER !== "1") return cachedGateway;
  if (process.platform !== "linux") return cachedGateway;
  try {
    // /proc/net/route: Destination 00000000 is the default route, Gateway is
    // the little-endian hex address, and flag bit 0x2 marks it as reachable.
    const raw = fs.readFileSync("/proc/net/route", "utf8");
    for (const line of raw.split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4) continue;
      const [, destination, gateway, flags] = columns;
      if (destination !== "00000000") continue;
      if (!(Number.parseInt(flags, 16) & 0x2)) continue;
      const ip = hexToIpv4(gateway);
      if (ip) cachedGateway = ip;
      break;
    }
  } catch {
    cachedGateway = null;
  }
  return cachedGateway;
}

function normalizeIp(value) {
  let address = String(value || "").trim().toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice(7);
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) address = address.slice(0, address.indexOf(":"));
  return address;
}

/**
 * True when the peer address is the container gateway, i.e. the host computer
 * that published this container's port.
 */
export function isContainerGateway(address) {
  const gateway = getContainerGatewayIp();
  if (!gateway) return false;
  return normalizeIp(address) === gateway;
}
