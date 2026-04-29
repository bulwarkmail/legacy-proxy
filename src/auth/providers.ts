import type { AppConfig, ProviderConfig } from "../util/config.js";

export function resolveProvider(cfg: AppConfig, name?: string): ProviderConfig {
  const key = name ?? cfg.defaultProvider;
  const p = cfg.providers[key];
  if (!p) throw new Error(`Unknown provider: ${key}`);
  return interpolate(p);
}

function interpolate(p: ProviderConfig): ProviderConfig {
  return {
    imap: { ...p.imap, host: env(p.imap.host) },
    smtp: { ...p.smtp, host: env(p.smtp.host) },
    sieve: p.sieve ? { ...p.sieve, host: env(p.sieve.host) } : null,
    auth: p.auth,
  };
}

function env(s: string): string {
  return s.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_m, k: string) => process.env[k] ?? "");
}
