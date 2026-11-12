import dns from "node:dns/promises";
import type { LookupFunction } from "node:net";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// Push URLs come from the client, so without this check any signed-in user
// could make the proxy POST to loopback, the cluster network or a cloud
// metadata endpoint. A self-hosted relay on a private network opts back in
// with PUSH_ALLOW_PRIVATE_URLS=1, which also allows plain http.
const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) blocked.addSubnet(addr, prefix, "ipv6");

// IPv6 ranges that carry an IPv4 address the packets end up at:
// NAT64 (RFC 6052) in the last 32 bits, 6to4 (RFC 3056) in bits 16 to 47,
// Teredo (RFC 4380) as the server address in bits 32 to 63 and the client
// address, inverted, in the last 32 bits.
const nat64 = new net.BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");
const sixToFour = new net.BlockList();
sixToFour.addSubnet("2002::", 16, "ipv6");
const teredo = new net.BlockList();
teredo.addSubnet("2001::", 32, "ipv6");

/**
 * True for any address that is not a public unicast one, including an IPv6
 * address whose embedded IPv4 address (NAT64, 6to4, Teredo) is not public.
 * BlockList also matches the IPv4 rules against IPv4-mapped IPv6 addresses
 * (::ffff:a00:5).
 */
export function isPrivateAddress(address: string): boolean {
  if (!net.isIP(address)) return true;
  if (net.isIPv6(address)) {
    const g = ipv6Groups(address);
    const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
    const embedded: string[] = [];
    if (nat64.check(address, "ipv6")) embedded.push(v4(g[6]!, g[7]!));
    if (sixToFour.check(address, "ipv6")) embedded.push(v4(g[1]!, g[2]!));
    if (teredo.check(address, "ipv6")) embedded.push(v4(g[2]!, g[3]!), v4(g[6]! ^ 0xffff, g[7]! ^ 0xffff));
    return embedded.some(isPrivateAddress) || blocked.check(address, "ipv6");
  }
  return blocked.check(address, "ipv4");
}

/** The eight 16-bit groups of an IPv6 address, `::` and a dotted IPv4 tail expanded. */
function ipv6Groups(address: string): number[] {
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const last = [h, t].find((part) => part.length > 0 && part[part.length - 1]!.includes("."));
  if (last) {
    const octets = last.pop()!.split(".").map(Number);
    last.push(((octets[0]! << 8) | octets[1]!).toString(16), ((octets[2]! << 8) | octets[3]!).toString(16));
  }
  return [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t].map((x) => parseInt(x || "0", 16));
}

/** Why a push URL was refused. The message is fixed text: it never carries the URL. */
export class PushTargetError extends Error {
  override name = "PushTargetError";
}

export interface PushTarget {
  url: URL;
  /** The host name without IPv6 brackets: what TLS checks the certificate against. */
  host: string;
  /** The checked address every connection for this push goes to. */
  address: string;
  family: 4 | 6;
}

/**
 * Resolve a push URL's host once and check it: https only (http too with
 * PUSH_ALLOW_PRIVATE_URLS=1), no user name in the URL, a name that resolves,
 * and every address it resolves to public (unless PUSH_ALLOW_PRIVATE_URLS=1).
 * The answer carries the address that passed, for postPush to connect to.
 */
export async function resolvePushTarget(raw: string): Promise<PushTarget> {
  const allowPrivate = process.env.PUSH_ALLOW_PRIVATE_URLS === "1";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PushTargetError("push URL is not a URL");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) {
    throw new PushTargetError("push URL must use https");
  }
  if (url.username || url.password) throw new PushTargetError("push URL must not carry credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let answers: { address: string; family: number }[];
  try {
    answers = await dns.lookup(host, { all: true });
  } catch {
    throw new PushTargetError("push URL host does not resolve");
  }
  const first = answers[0];
  if (!first) throw new PushTargetError("push URL host does not resolve");
  if (!allowPrivate && answers.some((a) => isPrivateAddress(a.address))) {
    throw new PushTargetError("push URL resolves to a non-public address");
  }
  return { url, host, address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** Throws PushTargetError unless resolvePushTarget accepts the URL. */
export async function assertPublicPushTarget(url: string): Promise<void> {
  await resolvePushTarget(url);
}

/** The host of a push URL, for logs: the URL itself can carry a device token. */
export function pushHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid)";
  }
}

/** A lookup that answers every name with the one address that was checked. */
function pinnedLookup(address: string, family: 4 | 6): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  }) as LookupFunction;
}

export interface PushInit {
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}

/**
 * POST a push. The host is resolved and checked once (resolvePushTarget) and
 * the connection goes to exactly that address; TLS still verifies the
 * certificate against the host name. Redirects are not followed: a 3xx is
 * an answer like any other that isn't 2xx. The response body is discarded.
 */
export async function postPush(url: string, init: PushInit): Promise<{ status: number; ok: boolean }> {
  const target = await resolvePushTarget(url);
  const request = target.url.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: target.url.protocol,
        hostname: target.host,
        port: target.url.port || undefined,
        path: target.url.pathname + target.url.search,
        method: "POST",
        headers: { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) },
        lookup: pinnedLookup(target.address, target.family),
        // A connection of its own: a pooled socket could belong to another address.
        agent: false,
        ...(init.signal ? { signal: init.signal } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.destroy();
        resolve({ status, ok: status >= 200 && status < 300 });
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}
