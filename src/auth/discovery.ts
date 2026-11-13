// Discovery of the IMAP and SMTP servers of an email domain that
// providers.json does not list (DISCOVERY, see util/config.ts). The proxy is
// public, so everything a domain publishes is treated as untrusted:
//
// - Only TLS endpoints are taken: IMAP with implicit TLS or STARTTLS on any
//   port, submission with implicit TLS on 465 or STARTTLS on 587.
//   Certificates are verified as for any other provider.
// - Every host, the autoconfig web servers included, must be a plain host
//   name that resolves to public addresses only (isPrivateAddress), and the
//   IMAP and SMTP hosts must match DISCOVERY_ALLOWED_HOSTS when it is set.
// - The autoconfig fetch connects to the address that passed the check, has
//   a timeout and a size cap, and follows redirects only to https on the same
//   host. The IMAP and SMTP connections of a discovered provider resolve and
//   check their host again at every connect and go to that checked address
//   (imap/client.ts, smtp/submit.ts), with the host name kept for TLS.
// - Answers, found or not, are cached per domain for a while, and lookups
//   for one domain running at the same time share one discovery.

import dns from "node:dns/promises";
import https from "node:https";
import { domainToASCII } from "node:url";
import type { TransportEntry } from "./providers.js";
import { plainHostName, type DiscoveryConfig, type DiscoverySource, type ProviderConfig } from "../util/config.js";
import { isPrivateAddress, pinnedLookup } from "../util/pushTarget.js";
import { log } from "../util/log.js";

/** Why a discovered host or file was not used. The message names hosts, never a user. */
export class DiscoveryRefusal extends Error {
  override name = "DiscoveryRefusal";
}

export type LookupAll = (host: string) => Promise<{ address: string; family: number }[]>;

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export interface DiscoveryDeps {
  lookup: LookupAll;
  resolveSrv: (name: string) => Promise<SrvRecord[]>;
  /** GET an https URL; the text of a 200 answer, or a thrown error. */
  fetchText: (url: string) => Promise<string>;
  now: () => number;
}

export interface DiscoveryOptions {
  successTtlMs: number;
  failureTtlMs: number;
  maxEntries: number;
  /** Time for one domain's whole discovery. */
  totalTimeoutMs: number;
  dnsTimeoutMs: number;
  fetchTimeoutMs: number;
  maxBytes: number;
}

export const DISCOVERY_DEFAULTS: DiscoveryOptions = {
  successTtlMs: 60 * 60_000,
  failureTtlMs: 5 * 60_000,
  maxEntries: 1_000,
  totalTimeoutMs: 10_000,
  dnsTimeoutMs: 3_000,
  fetchTimeoutMs: 5_000,
  maxBytes: 64 * 1024,
};

/** One IMAP or SMTP server a source offers, already limited to TLS. */
export type Candidate = TransportEntry & { secure: boolean; starttls: boolean };

/** The servers one source offers, in its order of preference, and what it offered that was refused. */
export interface Offer {
  imap: Candidate[];
  smtp: Candidate[];
  refused: string[];
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new DiscoveryRefusal(`${what} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const defaultLookup: LookupAll = (host) => dns.lookup(host, { all: true });

/**
 * Resolve `host` and return the address to connect to. Throws
 * DiscoveryRefusal when it does not resolve or when any address it resolves
 * to is private, loopback, link-local or otherwise not public.
 */
export async function resolvePublicAddress(
  host: string,
  lookup: LookupAll = defaultLookup,
  timeoutMs = DISCOVERY_DEFAULTS.dnsTimeoutMs,
): Promise<{ address: string; family: 4 | 6 }> {
  let answers: { address: string; family: number }[];
  try {
    answers = await withTimeout(lookup(host), timeoutMs, `looking up ${host}`);
  } catch (e) {
    if (e instanceof DiscoveryRefusal) throw e;
    throw new DiscoveryRefusal(`${host} does not resolve`);
  }
  const first = answers[0];
  if (!first) throw new DiscoveryRefusal(`${host} does not resolve`);
  if (answers.some((a) => isPrivateAddress(a.address))) {
    throw new DiscoveryRefusal(`${host} resolves to a non-public address`);
  }
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** True when `host` is one of `allowed`, or a name below one of them. Empty `allowed` allows every host. */
export function hostAllowed(host: string, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  const h = host.toLowerCase();
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(parseInt(lower.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[lower] ?? "";
  });
}

function elementText(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}\\s*>`, "i").exec(block);
  return m ? decodeXml(m[1]!).trim() : undefined;
}

function serverBlocks(xml: string, element: string, type: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${element}\\b([^>]*)>([\\s\\S]*?)</${element}\\s*>`, "gi");
  for (const m of xml.matchAll(re)) {
    const attr = /\btype\s*=\s*["']([^"']*)["']/i.exec(m[1]!);
    if (attr && attr[1]!.trim().toLowerCase() === type) out.push(m[2]!);
  }
  return out;
}

/**
 * The IMAP and SMTP servers of a Mozilla autoconfig file (config-v1.1.xml),
 * in the file's order. `%EMAILDOMAIN%` in a host name is replaced by
 * `domain`; a host name that is not a plain host name after that, a server
 * without TLS, a submission server on a port other than 465 (implicit TLS)
 * or 587 (STARTTLS), and a user name other than `%EMAILADDRESS%` or
 * `%EMAILLOCALPART%` are refused.
 */
export function parseAutoconfig(xml: string, domain: string): Offer {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "");
  const offer: Offer = { imap: [], smtp: [], refused: [] };
  const read = (service: "imap" | "smtp", block: string): void => {
    const rawHost = elementText(block, "hostname") ?? "";
    const named = rawHost.replace(/%EMAILDOMAIN%/g, domain);
    const host = plainHostName(named);
    const label = `autoconfig ${service} ${JSON.stringify(rawHost)}`;
    if (!host) return void offer.refused.push(`${label}: not a plain host name`);
    const portText = elementText(block, "port") ?? "";
    const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
    if (!(port >= 1 && port <= 65535)) return void offer.refused.push(`${label}: no valid port`);
    const socketType = (elementText(block, "socketType") ?? "plain").toUpperCase();
    let secure: boolean;
    if (socketType === "SSL" || socketType === "TLS") secure = true;
    else if (socketType === "STARTTLS") secure = false;
    else return void offer.refused.push(`${label}: no TLS (socketType ${socketType.toLowerCase()})`);
    if (service === "smtp" && port !== (secure ? 465 : 587)) {
      return void offer.refused.push(`${label}: submission must be on 465 with implicit TLS or on 587 with STARTTLS`);
    }
    const username = elementText(block, "username");
    let localPartLogin = false;
    if (username === "%EMAILLOCALPART%") localPartLogin = true;
    else if (username !== undefined && username !== "" && username !== "%EMAILADDRESS%") {
      return void offer.refused.push(`${label}: user name ${JSON.stringify(username)} is not the email address or its local part`);
    }
    offer[service].push({ host, port, secure, starttls: !secure, ...(localPartLogin ? { localPartLogin } : {}) });
  };
  for (const block of serverBlocks(body, "incomingServer", "imap")) read("imap", block);
  for (const block of serverBlocks(body, "outgoingServer", "smtp")) read("smtp", block);
  return offer;
}

/**
 * SRV records in the order to try them (RFC 2782): lowest priority first,
 * and within one priority the highest weight first. A record whose target is
 * "." says the service is not offered.
 */
export function orderSrv(records: SrvRecord[]): SrvRecord[] {
  return records
    .filter((r) => r.name !== "" && r.name !== ".")
    .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
}

// RFC 6186 and RFC 8314 services: implicit TLS first.
const SRV_SERVICES: { name: string; service: "imap" | "smtp"; secure: boolean; port?: number }[] = [
  { name: "_imaps._tcp", service: "imap", secure: true },
  { name: "_imap._tcp", service: "imap", secure: false },
  { name: "_submissions._tcp", service: "smtp", secure: true, port: 465 },
  { name: "_submission._tcp", service: "smtp", secure: false, port: 587 },
];

/** The servers the RFC 6186 SRV records of `domain` name, in the order to try them. */
export async function srvOffer(domain: string, resolveSrv: (name: string) => Promise<SrvRecord[]>): Promise<Offer> {
  const offer: Offer = { imap: [], smtp: [], refused: [] };
  const answers = await Promise.all(
    SRV_SERVICES.map(async (s) => {
      try {
        return await resolveSrv(`${s.name}.${domain}`);
      } catch {
        return [];
      }
    }),
  );
  SRV_SERVICES.forEach((s, i) => {
    for (const r of orderSrv(answers[i]!)) {
      const label = `srv ${s.name} ${JSON.stringify(r.name)}:${r.port}`;
      const host = plainHostName(r.name);
      if (!host) {
        offer.refused.push(`${label}: not a plain host name`);
        continue;
      }
      if (!(r.port >= 1 && r.port <= 65535) || (s.port !== undefined && r.port !== s.port)) {
        offer.refused.push(`${label}: wrong port`);
        continue;
      }
      offer[s.service].push({ host, port: r.port, secure: s.secure, starttls: !s.secure });
    }
  });
  return offer;
}

/**
 * GET an https URL and return the body of a 200 answer, at most `maxBytes`.
 * The host must resolve to public addresses only, and the connection goes to
 * the address that was checked; the certificate is verified against the host
 * name. Redirects are followed (at most 3) only to https on the same host.
 */
export async function fetchPinned(
  url: string,
  opts: { lookup?: LookupAll; timeoutMs: number; dnsTimeoutMs?: number; maxBytes: number; redirectsLeft?: number },
): Promise<string> {
  const u = new URL(url);
  if (u.protocol !== "https:" || u.username || u.password) throw new DiscoveryRefusal(`${u.host}: only https without credentials`);
  const host = plainHostName(u.hostname);
  if (!host) throw new DiscoveryRefusal(`${u.hostname}: not a plain host name`);
  const target = await resolvePublicAddress(host, opts.lookup, opts.dnsTimeoutMs);
  const answer = await new Promise<{ status: number; location?: string; body?: string }>((resolve, reject) => {
    const req = https.request(
      {
        hostname: host,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: "GET",
        headers: { accept: "application/xml, text/xml" },
        lookup: pinnedLookup(target.address, target.family),
        // A connection of its own: a pooled socket could belong to another address.
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status !== 200) {
          const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
          res.destroy();
          return resolve({ status, location });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            res.destroy();
            req.destroy();
            return reject(new DiscoveryRefusal(`${host}: answer larger than ${opts.maxBytes} bytes`));
          }
          chunks.push(chunk);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.setTimeout(opts.timeoutMs, () => req.destroy(new DiscoveryRefusal(`${host}: timed out`)));
    req.on("error", reject);
    req.end();
  });
  if (answer.body !== undefined) return answer.body;
  if (answer.status >= 300 && answer.status < 400 && answer.location) {
    const next = new URL(answer.location, u);
    const left = opts.redirectsLeft ?? 3;
    if (left <= 0) throw new DiscoveryRefusal(`${host}: too many redirects`);
    if (!redirectAllowed(u, next)) throw new DiscoveryRefusal(`${host}: redirect to another host or to http`);
    return fetchPinned(next.href, { ...opts, redirectsLeft: left - 1 });
  }
  throw new DiscoveryRefusal(`${host}: answered ${answer.status}`);
}

/** A redirect is followed only to https on the same host and port. */
export function redirectAllowed(from: URL, to: URL): boolean {
  return to.protocol === "https:" && to.hostname.toLowerCase() === from.hostname.toLowerCase() && to.port === from.port && !to.username && !to.password;
}

export class ProviderDiscovery {
  private readonly deps: DiscoveryDeps;
  private readonly opts: DiscoveryOptions;
  private readonly cache = new Map<string, { value: ProviderConfig | null; expires: number }>();
  private readonly running = new Map<string, Promise<ProviderConfig | null>>();

  constructor(
    private readonly config: DiscoveryConfig,
    deps: Partial<DiscoveryDeps> = {},
    opts: Partial<DiscoveryOptions> = {},
  ) {
    this.opts = { ...DISCOVERY_DEFAULTS, ...opts };
    const lookup = deps.lookup ?? defaultLookup;
    const resolver = new dns.Resolver({ timeout: this.opts.dnsTimeoutMs, tries: 2 });
    this.deps = {
      lookup,
      resolveSrv: deps.resolveSrv ?? ((name) => resolver.resolveSrv(name)),
      fetchText:
        deps.fetchText ??
        ((url) =>
          fetchPinned(url, {
            lookup,
            timeoutMs: this.opts.fetchTimeoutMs,
            dnsTimeoutMs: this.opts.dnsTimeoutMs,
            maxBytes: this.opts.maxBytes,
          })),
      now: deps.now ?? Date.now,
    };
  }

  get enabled(): boolean {
    return this.config.sources.length > 0;
  }

  /** Domains with a cached answer. */
  get size(): number {
    return this.cache.size;
  }

  /**
   * The provider discovered for `domain`, or null when discovery is off,
   * the domain is not a plain host name, or no source offers a usable IMAP
   * and SMTP server. Answers are cached: found ones for successTtlMs, missing
   * ones for failureTtlMs.
   */
  async discover(domain: string): Promise<ProviderConfig | null> {
    if (!this.enabled) return null;
    const key = domain.trim().toLowerCase();
    const now = this.deps.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value && structuredClone(hit.value);
    if (hit) this.cache.delete(key);
    let running = this.running.get(key);
    if (!running) {
      running = withTimeout(this.run(key), this.opts.totalTimeoutMs, `discovery for ${key}`)
        .catch((e: unknown) => {
          log.info({ domain: key, reason: (e as Error).message }, "discovery found no mail servers");
          return null;
        })
        .then((value) => {
          this.remember(key, value);
          return value;
        })
        .finally(() => this.running.delete(key));
      this.running.set(key, running);
    }
    const value = await running;
    return value && structuredClone(value);
  }

  private remember(key: string, value: ProviderConfig | null): void {
    const ttl = value ? this.opts.successTtlMs : this.opts.failureTtlMs;
    this.cache.delete(key);
    this.cache.set(key, { value, expires: this.deps.now() + ttl });
    for (const oldest of this.cache.keys()) {
      if (this.cache.size <= this.opts.maxEntries) break;
      this.cache.delete(oldest);
    }
  }

  private async run(domain: string): Promise<ProviderConfig | null> {
    const ascii = domainToASCII(domain);
    const name = ascii ? plainHostName(ascii) : null;
    if (!name) {
      log.info({ domain }, "discovery skipped: the email domain is not a plain host name");
      return null;
    }
    const reasons: string[] = [];
    for (const source of this.config.sources) {
      for (const offer of this.offers(source, name)) {
        let o: Offer;
        try {
          o = await offer;
        } catch (e) {
          reasons.push(`${source}: ${(e as Error).message}`);
          continue;
        }
        reasons.push(...o.refused);
        const imap = await this.pick(o.imap, reasons);
        const smtp = imap ? await this.pick(o.smtp, reasons) : null;
        if (imap && smtp) {
          log.info({ domain, source, imap: `${imap.host}:${imap.port}`, smtp: `${smtp.host}:${smtp.port}` }, "discovery found mail servers");
          return { imap, smtp, sieve: null, carddav: null, auth: { mech: ["PLAIN", "LOGIN"] }, discovered: { domain, source } };
        }
        if (o.imap.length || o.smtp.length) reasons.push(`${source}: no usable ${imap ? "smtp" : "imap"} server`);
      }
    }
    log.info({ domain, reasons }, "discovery found no usable mail servers");
    return null;
  }

  /** The offers of one source, lazily, so a later one is only fetched when an earlier one had nothing usable. */
  private *offers(source: DiscoverySource, domain: string): Generator<Promise<Offer>> {
    if (source === "autoconfig") {
      for (const url of [
        `https://autoconfig.${domain}/mail/config-v1.1.xml`,
        `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`,
      ]) {
        yield this.deps.fetchText(url).then((xml) => parseAutoconfig(xml, domain));
      }
    } else {
      yield srvOffer(domain, this.deps.resolveSrv);
    }
  }

  /** The first candidate whose host is allowed and resolves to public addresses only. */
  private async pick(candidates: Candidate[], reasons: string[]): Promise<Candidate | null> {
    for (const c of candidates) {
      if (!hostAllowed(c.host, this.config.allowedHosts)) {
        reasons.push(`${c.host}: not in DISCOVERY_ALLOWED_HOSTS`);
        continue;
      }
      try {
        await resolvePublicAddress(c.host, this.deps.lookup, this.opts.dnsTimeoutMs);
        return c;
      } catch (e) {
        reasons.push((e as Error).message);
      }
    }
    return null;
  }
}

/**
 * A discovered provider read back from the database, checked as discovery
 * would check it now: plain host names, TLS, the submission ports and
 * DISCOVERY_ALLOWED_HOSTS. Null when it no longer passes. Addresses are
 * checked at every connect, not here.
 */
export function storedDiscoveredProvider(domain: string, json: string, config: DiscoveryConfig): ProviderConfig | null {
  let p: ProviderConfig;
  try {
    p = JSON.parse(json) as ProviderConfig;
  } catch {
    return null;
  }
  const entry = (e: unknown, service: "imap" | "smtp"): Candidate | null => {
    if (!e || typeof e !== "object") return null;
    const { host, port, secure, starttls, localPartLogin } = e as Record<string, unknown>;
    const h = typeof host === "string" ? plainHostName(host) : null;
    if (!h || h !== host || !hostAllowed(h, config.allowedHosts)) return null;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (typeof secure !== "boolean" || starttls !== !secure) return null;
    if (service === "smtp" && port !== (secure ? 465 : 587)) return null;
    return { host: h, port, secure, starttls: !secure, ...(localPartLogin === true ? { localPartLogin: true } : {}) };
  };
  const imap = entry(p?.imap, "imap");
  const smtp = entry(p?.smtp, "smtp");
  const source = p?.discovered?.source;
  if (!imap || !smtp || (source !== "autoconfig" && source !== "srv")) return null;
  return { imap, smtp, sieve: null, carddav: null, auth: { mech: ["PLAIN", "LOGIN"] }, discovered: { domain, source } };
}

/**
 * Where to connect for one service of `provider`. For a discovered provider
 * the host is resolved and checked again now, and the connection goes to the
 * checked address with the host name as TLS server name, so the name can't
 * point somewhere else between the check and the connect. A configured
 * provider connects to its host as before.
 */
export async function connectHost(
  provider: ProviderConfig,
  entry: { host: string },
  lookup?: LookupAll,
): Promise<{ host: string; servername?: string }> {
  if (!provider.discovered) return { host: entry.host };
  const { address } = await resolvePublicAddress(entry.host, lookup);
  return { host: address, servername: entry.host };
}
