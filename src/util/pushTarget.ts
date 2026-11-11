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

// NAT64 (RFC 6052): the last 32 bits are an IPv4 address the gateway connects to.
const nat64 = new net.BlockList();
nat64.addSubnet("64:ff9b::", 96, "ipv6");

/**
 * True for any address that is not a public unicast one. BlockList also
 * matches the IPv4 rules against IPv4-mapped IPv6 addresses (::ffff:a00:5).
 */
export function isPrivateAddress(address: string): boolean {
  if (!net.isIP(address)) return true;
  if (net.isIPv6(address)) {
    if (nat64.check(address, "ipv6")) return isPrivateAddress(ipv4FromNat64(address));
    return blocked.check(address, "ipv6");
  }
  return blocked.check(address, "ipv4");
}

function ipv4FromNat64(address: string): string {
  // Expand to eight groups and read the last two as four octets; a mixed
  // form (64:ff9b::10.0.0.5) already ends in the IPv4 address.
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (t.length > 0 && t[t.length - 1]!.includes(".")) return t[t.length - 1]!;
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  const hi = groups[6] ?? 0;
  const lo = groups[7] ?? 0;
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
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
