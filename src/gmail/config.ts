import fs from "node:fs";

export const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

export const GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";

export interface GmailConfig {
  writeEnabled?: boolean;
  composeEnabled?: boolean;
  aliasesEnabled?: boolean;
  /** Carry Gmail user labels as `$label:` keywords as well as mailboxes. On unless explicitly disabled. */
  labelTags?: boolean;
  /** Delayed send queue (FUTURERELEASE). Absent = immediate sends only. */
  schedule?: { maxDelayedSend: number; lateTolerance: number };
  /**
   * Gmail push via Cloud Pub/Sub: the `users.watch` topic plus how the push endpoint authenticates Pub/Sub,
   * either a Google-signed OIDC token (audience + service account) or a shared query-string secret.
   */
  push?: { topic: string; token?: string; audience?: string; serviceAccount?: string };
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  origin: string;
  /** Addresses (`user@example.com`) and whole domains (`@example.com`) allowed to connect. */
  allowedEmails: AllowList;
  secureCookies: boolean;
  /**
   * Applications allowed to sign users in through the bridge (OAuth 2.0 authorization code with PKCE),
   * so an account can be added to a mail client with a Google sign-in instead of a bridge password.
   * Absent or empty: the bridge is no authorization server and only bridge passwords sign in.
   */
  oauthClients?: OAuthClient[];
}

/** A public OAuth client: its id and the redirect URIs it may use; `*` stands for one path segment. */
export interface OAuthClient {
  id: string;
  redirectUris: string[];
}

export function parseOAuthClients(raw: string | undefined): OAuthClient[] {
  if (!raw?.trim()) return [];
  const list: unknown = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error("GMAIL_OAUTH_CLIENTS must be a JSON array");
  return list.map((c: { id?: unknown; redirectUris?: unknown }) => {
    const uris = Array.isArray(c?.redirectUris) ? c.redirectUris : [];
    if (
      typeof c?.id !== "string" ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(c.id) ||
      !uris.length ||
      !uris.every((u) => {
        if (typeof u !== "string") return false;
        try {
          const url = new URL(u.replaceAll("*", "x"));
          return (
            !url.hash &&
            (url.protocol === "https:" ||
              (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
          );
        } catch {
          return false;
        }
      })
    )
      throw new Error(
        'GMAIL_OAUTH_CLIENTS entries need an "id" and HTTPS "redirectUris" (HTTP only on loopback)',
      );
    return { id: c.id, redirectUris: uris as string[] };
  });
}

/** Exact match, where `*` in the registered URI stands for one path segment (a locale, say). */
export function redirectAllowed(client: OAuthClient, uri: string): boolean {
  return client.redirectUris.some((pattern) =>
    new RegExp(
      "^" + pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/?#]+") + "$",
    ).test(uri),
  );
}

/** Set-like allowlist: exact lower-case addresses plus `@domain` entries. */
export class AllowList {
  private readonly addresses = new Set<string>();
  private readonly domains = new Set<string>();
  constructor(entries: Iterable<string>) {
    for (const raw of entries) {
      const entry = raw.trim().toLowerCase();
      if (!entry) continue;
      if (entry.startsWith("@")) {
        if (entry.length > 1 && !entry.slice(1).includes("@")) this.domains.add(entry.slice(1));
      } else if (entry.includes("@")) this.addresses.add(entry);
    }
  }
  get size(): number {
    return this.addresses.size + this.domains.size;
  }
  has(email: string): boolean {
    const e = email.trim().toLowerCase();
    if (this.addresses.has(e)) return true;
    const at = e.lastIndexOf("@");
    return at > 0 && this.domains.has(e.slice(at + 1));
  }
}

const positive = (value: string | undefined, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new Error("Gmail schedule settings must be positive integers (seconds)");
  return n;
};

const pushConfig = (
  topic: string,
  token: string | undefined,
  audience: string | undefined,
  serviceAccount: string | undefined,
) => {
  if (!/^projects\/[a-z][-a-z0-9:.]{4,28}[a-z0-9]\/topics\/[A-Za-z][-A-Za-z0-9._~%+]{2,254}$/.test(topic))
    throw new Error("GMAIL_PUSH_TOPIC must look like projects/<project>/topics/<topic>");
  // Authenticated push keeps secrets out of URLs and reverse-proxy access logs; prefer it when configured.
  if (audience) {
    if (!serviceAccount || !/^[^\s@]+@[^\s@]+$/.test(serviceAccount))
      throw new Error("GMAIL_PUSH_SERVICE_ACCOUNT must name the service account of the push subscription");
    return { topic, audience, serviceAccount: serviceAccount.toLowerCase() };
  }
  if (!token || token.length < 24)
    throw new Error(
      "GMAIL_PUSH_TOKEN must be a secret of at least 24 characters (or set GMAIL_PUSH_AUDIENCE for authenticated push)",
    );
  return { topic, token };
};

/** Opt-in: absent credentials leave every existing legacy deployment unchanged. */
export function loadGmailConfig(publicUrl: string): GmailConfig | null {
  const file = process.env.GMAIL_OAUTH_CLIENT_FILE;
  if (!file) return null;
  const { web } = JSON.parse(fs.readFileSync(file, "utf8"));
  if (
    typeof web?.client_id !== "string" ||
    !web.client_id ||
    typeof web?.client_secret !== "string" ||
    !web.client_secret
  ) {
    throw new Error("GMAIL_OAUTH_CLIENT_FILE must contain a Google Web OAuth client");
  }
  const base = new URL(publicUrl);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
  ) {
    throw new Error("Gmail PUBLIC_URL must be an HTTPS origin (HTTP loopback is allowed for development)");
  }
  const allowedEmails = new AllowList((process.env.GMAIL_ALLOWED_EMAILS ?? "").split(","));
  if (!allowedEmails.size)
    throw new Error("GMAIL_ALLOWED_EMAILS must name the accounts or @domains allowed to connect");
  return {
    writeEnabled: process.env.GMAIL_WRITE_ENABLED === "true",
    composeEnabled: process.env.GMAIL_COMPOSE_ENABLED === "true",
    aliasesEnabled: process.env.GMAIL_ALIASES_ENABLED === "true",
    labelTags: process.env.GMAIL_LABEL_TAGS !== "false",
    ...(process.env.GMAIL_SCHEDULE_ENABLED === "true"
      ? {
          schedule: {
            maxDelayedSend: positive(process.env.GMAIL_MAX_DELAYED_SEND, 30 * 86400),
            lateTolerance: positive(process.env.GMAIL_SCHEDULE_LATE_TOLERANCE, 900),
          },
        }
      : {}),
    ...(process.env.GMAIL_PUSH_TOPIC
      ? {
          push: pushConfig(
            process.env.GMAIL_PUSH_TOPIC,
            process.env.GMAIL_PUSH_TOKEN,
            process.env.GMAIL_PUSH_AUDIENCE,
            process.env.GMAIL_PUSH_SERVICE_ACCOUNT,
          ),
        }
      : {}),
    clientId: web.client_id,
    clientSecret: web.client_secret,
    origin: base.origin,
    redirectUri: `${base.origin}/auth/google/callback`,
    allowedEmails,
    secureCookies: base.protocol === "https:",
    oauthClients: parseOAuthClients(process.env.GMAIL_OAUTH_CLIENTS),
  };
}
