import dns from "node:dns/promises";
import net from "node:net";

// Push URLs come from the client, so without this check any signed-in user
// could make the proxy POST to loopback, the cluster network or a cloud
// metadata endpoint. A self-hosted relay on a private network opts back in.
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const) blocked.addSubnet(addr, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, "ipv4");
  return blocked.check(address, net.isIPv6(address) ? "ipv6" : "ipv4");
}

/**
 * Rejects a push URL whose host resolves to a non-public address. A name that
 * does not resolve passes: the POST fails on its own. The address is checked
 * right before each POST but not pinned into the connection, so DNS rebinding
 * between the lookup and the connect is not covered.
 */
export async function assertPublicPushTarget(url: string): Promise<void> {
  if (process.env.PUSH_ALLOW_PRIVATE_URLS === "1") return;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return;
  }
  if (addrs.some((a) => isPrivateAddress(a.address))) {
    throw new Error("push URL resolves to a non-public address");
  }
}
