import fs from "node:fs";
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
   * Fastify's `trustProxy`: which reverse proxies may name the client address
   * in X-Forwarded-For. The login limits count per client address, so behind a
   * reverse proxy this must be set or every caller shares the proxy's address.
   */
  trustProxy: boolean | number | string;
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

/**
 * `TRUST_PROXY`: unset or `false` trusts no one (the socket's address is the
 * client's); `true` trusts every hop; a number trusts that many hops in front
 * of the proxy; anything else is a comma-separated list of proxy addresses or
 * CIDR ranges.
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = (value ?? "").trim();
  if (v === "" || /^(false|no|off)$/i.test(v)) return false;
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
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
      maxSizeRequest: Number(process.env.MAX_SIZE_REQUEST ?? 10_000_000),
      maxCallsInRequest: Number(process.env.MAX_CALLS_IN_REQUEST ?? 64),
    },
  };
}
