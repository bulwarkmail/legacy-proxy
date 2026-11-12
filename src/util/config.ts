import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { validateProviders } from "../auth/providers.js";

export interface ProviderConfig {
  /**
   * Email domains served by this provider. When a client authenticates with a
   * username in the form of an email address, the proxy maps the domain part to
   * this provider (RFC 8620 §2.2 uses the same domain-as-routing-key idea for
   * service autodiscovery). Lets one proxy front many IMAP backends without the
   * client having to name the provider explicitly.
   */
  domains?: string[];
  // `secure`: implicit TLS. `starttls`: plain connection that must be upgraded
  // before credentials are sent. A connection with neither is refused unless
  // the host is loopback or `allowPlaintext` is true (see auth/providers.ts).
  imap: { host: string; port: number; secure?: boolean; starttls?: boolean; allowPlaintext?: boolean };
  smtp: { host: string; port: number; secure?: boolean; starttls?: boolean; allowPlaintext?: boolean };
  sieve: { host: string; port: number; secure?: boolean; starttls?: boolean; allowPlaintext?: boolean } | null;
  carddav: {
    host: string;
    port: number;
    secure?: boolean;
    allowPlaintext?: boolean;
    basePath?: string;
    principalPath?: string;
    /**
     * DAV login for the one mail login named in `forUser`, when it differs
     * from the mail login. Everyone else keeps their IMAP credentials.
     */
    username?: string;
    password?: string;
    forUser?: string;
  } | null;
  auth: { mech: string[] };
}

export interface AppConfig {
  port: number;
  publicUrl: string;
  /**
   * The reverse proxies (IP addresses and CIDR ranges) that may name the
   * client address in X-Forwarded-For; empty trusts no one. The login limits
   * count per client address, so behind a reverse proxy this must be set or
   * every caller shares the proxy's address.
   */
  trustProxy: string[];
  dataDir: string;
  vaultKey: Buffer;
  sessionHmacKey: Buffer;
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
  limits: {
    maxConcurrentRequests: number;
    maxObjectsInGet: number;
    maxObjectsInSet: number;
    maxSizeUpload: number;
    /** Bytes of pending uploads one account may have stored at a time. */
    maxUploadStoragePerAccount: number;
    maxSizeRequest: number;
    maxCallsInRequest: number;
  };
}

function reqEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

function b64Key(name: string, fallback: string | null): Buffer {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing key env: ${name}`);
  const buf = Buffer.from(v, "base64");
  if (buf.length !== 32) throw new Error(`${name} must be base64 of 32 bytes`);
  return buf;
}

const TRUST_PROXY_HINT =
  "Set it to the address or network of the reverse proxy in front of the proxy, for example " +
  "TRUST_PROXY=127.0.0.1 for a reverse proxy on the same host, TRUST_PROXY=172.18.0.0/16 for one " +
  "on a container network, or that proxy's own address for one on another host; leave it unset " +
  "when nothing is in front.";

/**
 * The widest range accepted per address family in public space. A reverse
 * proxy's network is never larger; a wider one would let a large part of the
 * internet name its own address. Private and link-local ranges (see
 * PRIVATE_RANGES) may be given whole.
 */
export const TRUST_PROXY_MIN_PREFIX = { 4: 8, 6: 32 } as const;

/** One accepted entry as an inclusive range of addresses. */
interface AddressRange {
  family: 4 | 6;
  start: bigint;
  end: bigint;
}

// Private, shared, loopback and link-local space: no client on the internet
// arrives from there, so a range inside it is accepted at any width.
const PRIVATE_RANGES: AddressRange[] = (
  [
    ["10.0.0.0", 8, 4],
    ["172.16.0.0", 12, 4],
    ["192.168.0.0", 16, 4],
    ["100.64.0.0", 10, 4],
    ["127.0.0.0", 8, 4],
    ["169.254.0.0", 16, 4],
    ["fc00::", 7, 6],
    ["fe80::", 10, 6],
    ["::1", 128, 6],
  ] as const
).map(([address, bits, family]) => rangeOf(address, bits, family));

// IPv6 addresses that stand for IPv4 clients (::ffff:0:0/96): the web
// framework matches every IPv4 client against them.
const MAPPED_START = 0xffffn << 32n;
const MAPPED_END = MAPPED_START + (1n << 32n) - 1n;

/**
 * `TRUST_PROXY`: the reverse proxies whose X-Forwarded-For entries name the
 * client, as a comma-separated list of IP addresses and CIDR ranges
 * (`127.0.0.1`, `::1`, `10.0.0.0/8`). Unset, empty, `false`, `0`, `no` or
 * `off` trusts no one: the socket's address is the client's. Any other value
 * stops the start with a message: a hop count can't tell the reverse proxy
 * from a client that reaches the port directly; `true`, a public range wider
 * than TRUST_PROXY_MIN_PREFIX, an IPv4-mapped IPv6 range, or entries that together
 * cover every address would trust everyone or a large part of the internet;
 * and host names are not looked up.
 */
export function parseTrustProxy(value: string | undefined): string[] {
  const raw = value ?? "";
  if (/^\s*(false|no|off|0)?\s*$/i.test(raw)) return [];
  const fail = (problem: string) => new Error(`TRUST_PROXY=${JSON.stringify(raw)}: ${problem}. ${TRUST_PROXY_HINT}`);
  const entries = raw.split(",").map((s) => s.trim());
  const ranges: AddressRange[] = [];
  for (const entry of entries) {
    const parsed = parseTrustProxyEntry(entry);
    if (typeof parsed === "string") throw fail(parsed);
    ranges.push(parsed);
  }
  for (const family of [4, 6] as const) {
    if (coversEverything(ranges.filter((r) => r.family === family), family)) {
      throw fail(`together the entries cover every IPv${family} address, which would trust everyone`);
    }
  }
  return entries;
}

function parseTrustProxyEntry(entry: string): AddressRange | string {
  if (entry === "") return "it has an empty entry";
  if (/^\d+$/.test(entry)) {
    return `"${entry}" is a hop count, which can't tell the reverse proxy from a client that reaches the port directly`;
  }
  if (/^(true|yes|on)$/i.test(entry)) return `"${entry}" would trust every address`;
  if (/^(false|no|off)$/i.test(entry)) return `"${entry}" is not an address (leave TRUST_PROXY unset to trust no reverse proxy)`;
  const slash = entry.indexOf("/");
  const address = slash < 0 ? entry : entry.slice(0, slash);
  const family = address.includes("%") ? 0 : net.isIP(address);
  if (family !== 4 && family !== 6) return `"${entry}" is not an IP address or CIDR range (host names are not accepted)`;
  const width = family === 4 ? 32 : 128;
  const widest = TRUST_PROXY_MIN_PREFIX[family];
  let bits = width;
  if (slash >= 0) {
    const text = entry.slice(slash + 1);
    if (!/^\d{1,3}$/.test(text) || Number(text) > width) return `"${entry}" needs a prefix length up to ${width}`;
    bits = Number(text);
  }
  const range = rangeOf(address, bits, family);
  const isPrivate = PRIVATE_RANGES.some((p) => p.family === family && p.start <= range.start && range.end <= p.end);
  if (bits < widest && !isPrivate) {
    return (
      `"${entry}" is wider than /${widest}, which is larger than any reverse proxy's network ` +
      `(only private and link-local ranges such as 10.0.0.0/8, fc00::/7 or fe80::/10 may be given whole)`
    );
  }
  if (family === 6 && range.start <= MAPPED_END && range.end >= MAPPED_START) {
    return `"${entry}" covers IPv4-mapped addresses (::ffff:0:0/96), which stand for IPv4 clients; write the IPv4 address or range itself`;
  }
  return range;
}

/** The range an address net.isIP accepted and a prefix length cover. */
function rangeOf(address: string, bits: number, family: 4 | 6): AddressRange {
  const size = 1n << BigInt((family === 4 ? 32 : 128) - bits);
  const start = (addressValue(address, family) / size) * size;
  return { family, start, end: start + size - 1n };
}

/** An address net.isIP accepted, as a number. */
function addressValue(address: string, family: 4 | 6): bigint {
  if (family === 4) return address.split(".").reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
  let text = address.toLowerCase();
  // A trailing dotted quad stands for the last two groups.
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (quad) {
    const v4 = addressValue(quad[1]!, 4);
    text = `${text.slice(0, quad.index)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? (text.split("::") as [string, string]) : [text, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...new Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16) || 0), 0n);
}

/** True when the ranges together cover every address of the family. */
function coversEverything(ranges: AddressRange[], family: 4 | 6): boolean {
  const last = (1n << BigInt(family === 4 ? 32 : 128)) - 1n;
  let covered = -1n;
  for (const r of [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))) {
    if (r.start > covered + 1n) return false;
    if (r.end > covered) covered = r.end;
    if (covered >= last) return true;
  }
  return false;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const providersFile = process.env.PROVIDERS_FILE ?? path.join(process.cwd(), "providers.json");
  let providers: Record<string, ProviderConfig> = {};
  if (fs.existsSync(providersFile)) {
    providers = JSON.parse(fs.readFileSync(providersFile, "utf8"));
  }
  validateProviders(providers);

  return {
    port: Number(process.env.PORT ?? 8080),
    publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8080}`,
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    dataDir,
    vaultKey: b64Key("VAULT_KEY", null),
    sessionHmacKey: b64Key("SESSION_HMAC_KEY", null),
    defaultProvider: process.env.DEFAULT_PROVIDER ?? "generic",
    providers,
    limits: {
      maxConcurrentRequests: Number(process.env.MAX_CONCURRENT_REQUESTS ?? 10),
      maxObjectsInGet: Number(process.env.MAX_OBJECTS_IN_GET ?? 500),
      maxObjectsInSet: Number(process.env.MAX_OBJECTS_IN_SET ?? 500),
      maxSizeUpload: Number(process.env.MAX_SIZE_UPLOAD ?? 50_000_000),
      maxUploadStoragePerAccount: Number(process.env.MAX_UPLOAD_STORAGE_PER_ACCOUNT ?? 100_000_000),
      maxSizeRequest: Number(process.env.MAX_SIZE_REQUEST ?? 10_000_000),
      maxCallsInRequest: Number(process.env.MAX_CALLS_IN_REQUEST ?? 64),
    },
  };
}
