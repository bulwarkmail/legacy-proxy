import fs from "node:fs";
import path from "node:path";

export interface ProviderConfig {
  imap: { host: string; port: number; secure?: boolean; starttls?: boolean };
  smtp: { host: string; port: number; secure?: boolean; starttls?: boolean };
  sieve: { host: string; port: number; secure?: boolean; starttls?: boolean } | null;
  auth: { mech: string[] };
}

export interface AppConfig {
  port: number;
  publicUrl: string;
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

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
  fs.mkdirSync(dataDir, { recursive: true });

  const providersFile = process.env.PROVIDERS_FILE;
  let providers: Record<string, ProviderConfig> = {};
  if (providersFile && fs.existsSync(providersFile)) {
    providers = JSON.parse(fs.readFileSync(providersFile, "utf8"));
  }

  return {
    port: Number(process.env.PORT ?? 8080),
    publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8080}`,
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
