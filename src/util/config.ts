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
  "TRUST_PROXY=127.0.0.1 for a reverse proxy on the same host or TRUST_PROXY=172.18.0.0/16 for one " +
  "on a container network, or leave it unset when nothing is in front.";

/**
 * `TRUST_PROXY`: the reverse proxies whose X-Forwarded-For entries name the
 * client, as a comma-separated list of IP addresses and CIDR ranges
 * (`127.0.0.1`, `::1`, `10.0.0.0/8`). Unset or empty trusts no one: the
 * socket's address is the client's. Any other value stops the start with a
 * message: a hop count can't tell the reverse proxy from a client that reaches
 * the port directly, `true` or a /0 range trusts every address, and host names
 * are not looked up.
 */
export function parseTrustProxy(value: string | undefined): string[] {
  const raw = value ?? "";
  if (raw.trim() === "") return [];
  const entries = raw.split(",").map((s) => s.trim());
  for (const entry of entries) {
    const problem = trustProxyProblem(entry);
    if (problem) throw new Error(`TRUST_PROXY=${JSON.stringify(raw)}: ${problem}. ${TRUST_PROXY_HINT}`);
  }
  return entries;
}

function trustProxyProblem(entry: string): string | null {
  if (entry === "") return "it has an empty entry";
  if (/^\d+$/.test(entry)) {
    return `"${entry}" is a hop count, which can't tell the reverse proxy from a client that reaches the port directly`;
  }
  if (/^(true|yes|on)$/i.test(entry)) return `"${entry}" would trust every address`;
  if (/^(false|no|off)$/i.test(entry)) return `"${entry}" is not an address`;
  const slash = entry.indexOf("/");
  const address = slash < 0 ? entry : entry.slice(0, slash);
  const family = address.includes("%") ? 0 : net.isIP(address);
  if (!family) return `"${entry}" is not an IP address or CIDR range (host names are not accepted)`;
  if (slash < 0) return null;
  const bits = entry.slice(slash + 1);
  const max = family === 4 ? 32 : 128;
  if (!/^\d{1,3}$/.test(bits) || Number(bits) > max) return `"${entry}" needs a prefix length from 1 to ${max}`;
  if (Number(bits) === 0) return `"${entry}" covers every address, which would trust everyone`;
  return null;
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
