import net from "node:net";
import type { AppConfig, ProviderConfig } from "../util/config.js";

export type ProviderService = "imap" | "smtp" | "sieve" | "carddav";

/** The transport fields every service entry of a provider may carry. */
export interface TransportEntry {
  host: string;
  port: number;
  secure?: boolean;
  starttls?: boolean;
  allowPlaintext?: boolean;
}

/**
 * How a connection to one service is made. `secure` is implicit TLS from the
 * first byte; `starttls` is a plain connection that must be upgraded with
 * STARTTLS before any credential is sent. When `secure` is left out it
 * defaults to false if `starttls` is set, and otherwise to what the service
 * did before the flag existed: implicit TLS for IMAP, implicit TLS on port 465
 * for SMTP, plain for ManageSieve and CardDAV (http).
 */
export function transportOf(service: ProviderService, entry: TransportEntry): { secure: boolean; starttls: boolean } {
  const starttls = service !== "carddav" && entry.starttls === true;
  if (typeof entry.secure === "boolean") return { secure: entry.secure, starttls };
  if (starttls) return { secure: false, starttls };
  switch (service) {
    case "imap":
      return { secure: true, starttls };
    case "smtp":
      return { secure: entry.port === 465, starttls };
    default:
      return { secure: false, starttls };
  }
}

/** True for `localhost`, 127.0.0.0/8 and ::1, with or without a port or brackets. */
export function isLoopbackHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(h);
  if (bracketed) h = bracketed[1]!;
  else if (/^[^:]+:\d+$/.test(h)) h = h.slice(0, h.lastIndexOf(":"));
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "localhost") return true;
  if (net.isIPv4(h)) return h.startsWith("127.");
  if (net.isIPv6(h)) {
    if (h === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(h)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    return !!mapped && mapped[1]!.startsWith("127.");
  }
  return false;
}

/**
 * Why the entry must not be used, or null when it is fine. The password
 * travels in clear unless the connection is implicit TLS or STARTTLS; that is
 * accepted only on loopback or when the entry says `"allowPlaintext": true`.
 */
export function transportProblem(service: ProviderService, entry: TransportEntry): string | null {
  if (entry.secure === true && entry.starttls === true) {
    return `"secure": true and "starttls": true contradict each other: use "secure": true for implicit TLS or "starttls": true (with "secure": false) for STARTTLS`;
  }
  const { secure, starttls } = transportOf(service, entry);
  if (secure || starttls) return null;
  if (entry.allowPlaintext === true || isLoopbackHost(entry.host)) return null;
  if (service === "carddav") {
    return `the connection is plain http, so the password would be sent in clear: set "secure": true (https), or "allowPlaintext": true to accept an unencrypted connection`;
  }
  return `the connection is not encrypted, so the password would be sent in clear: set "secure": true (implicit TLS), "starttls": true (STARTTLS required), or "allowPlaintext": true to accept an unencrypted connection`;
}

/** Throws when the entry would send credentials over a connection that is not allowed. */
export function assertTransport(service: ProviderService, entry: TransportEntry, providerName?: string): void {
  const problem = transportProblem(service, entry);
  if (!problem) return;
  const where = `${service} (${entry.host}:${entry.port})`;
  throw new Error(providerName ? `provider "${providerName}", ${where}: ${problem}` : `${where}: ${problem}`);
}

/**
 * Check every provider's IMAP, SMTP, ManageSieve and CardDAV entry when the
 * providers file is loaded, so a wrong entry stops the start instead of
 * failing (or sending a password in clear) at the first login.
 */
export function validateProviders(providers: Record<string, ProviderConfig>): void {
  const problems: string[] = [];
  for (const [name, raw] of Object.entries(providers)) {
    if (!raw || typeof raw !== "object") continue;
    const p = interpolate(raw);
    const entries: [ProviderService, TransportEntry | null | undefined][] = [
      ["imap", p.imap],
      ["smtp", p.smtp],
      ["sieve", p.sieve],
      ["carddav", p.carddav],
    ];
    for (const [service, entry] of entries) {
      if (!entry) continue;
      try {
        assertTransport(service, entry, name);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
  }
  if (problems.length) throw new Error(`providers file: ${problems.join("; ")}`);
}

export function resolveProvider(cfg: AppConfig, name?: string): ProviderConfig {
  const key = name ?? cfg.defaultProvider;
  const p = Object.hasOwn(cfg.providers, key) ? cfg.providers[key] : undefined;
  if (!p) throw new Error(`Unknown provider: ${key}`);
  return interpolate(p);
}

/**
 * Find the provider key whose `domains` list contains the email's domain.
 * Returns undefined when the username is not an email address or no provider
 * claims the domain. Matching is case-insensitive.
 */
export function providerForEmail(cfg: AppConfig, email?: string): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return undefined;
  for (const [name, p] of Object.entries(cfg.providers)) {
    if (p.domains?.some((d) => d.trim().toLowerCase() === domain)) return name;
  }
  return undefined;
}

/**
 * Decide which provider key a login should use. Resolution order:
 *   1. an explicit provider supplied by the client (e.g. `/api/login` body),
 *   2. the provider claiming the email domain of the username,
 *   3. the configured default provider.
 */
export function resolveProviderName(
  cfg: AppConfig,
  opts: { explicit?: string; username?: string },
): string {
  if (opts.explicit) return opts.explicit;
  return providerForEmail(cfg, opts.username) ?? cfg.defaultProvider;
}

function interpolate(p: ProviderConfig): ProviderConfig {
  return {
    imap: p.imap ? { ...p.imap, host: env(p.imap.host) } : p.imap,
    smtp: p.smtp ? { ...p.smtp, host: env(p.smtp.host) } : p.smtp,
    sieve: p.sieve ? { ...p.sieve, host: env(p.sieve.host) } : null,
    carddav: p.carddav
      ? {
          ...p.carddav,
          host: env(p.carddav.host),
          basePath: p.carddav.basePath ? env(p.carddav.basePath) : undefined,
          principalPath: p.carddav.principalPath ? env(p.carddav.principalPath) : undefined,
          username: p.carddav.username ? env(p.carddav.username) : undefined,
          password: p.carddav.password ? env(p.carddav.password) : undefined,
          forUser: p.carddav.forUser ? env(p.carddav.forUser) : undefined,
        }
      : null,
    auth: p.auth,
  };
}

function env(s: string): string {
  return s.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_m, k: string) => process.env[k] ?? "");
}
