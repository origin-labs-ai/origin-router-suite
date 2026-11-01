import os from "os";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function isPrivate(address) {
  if (!address) return false;
  const match = address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  return a === 10
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

const VIRTUAL_INTERFACE = /vmware|vmnet|virtualbox|vbox|hyper-v|vethernet|bluetooth|tailscale|wsl|loopback|local area connection \*/;

function score(name, address) {
  const iface = String(name || "").toLowerCase();
  let value = VIRTUAL_INTERFACE.test(iface) ? 0 : 10;
  if (/wi-?fi|wlan|ethernet|eth\d|en\d/.test(iface)) value += 5;
  if (address.startsWith("192.168.")) value += 4;
  else if (address.startsWith("10.")) value += 3;
  else if (address.startsWith("172.")) value += 2;
  else if (address.startsWith("169.254.")) value -= 5;
  return value;
}

// GET /api/network-info - private IPv4 addresses the Endpoint page can show as
// "open this URL from your phone". Loopback is deliberately excluded.
export async function GET() {
  const port = process.env.PORT || 20128;
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivate(entry.address)) continue;
      addresses.push({
        name,
        address: entry.address,
        url: `http://${entry.address}:${port}`,
        score: score(name, entry.address),
      });
    }
  }
  addresses.sort((a, b) => b.score - a.score);
  return NextResponse.json({
    port,
    preferred: addresses[0] || null,
    addresses: addresses.map(({ name, address, url }) => ({ name, address, url })),
  });
}
