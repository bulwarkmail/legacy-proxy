// Login grants: with LOGIN_GRANT_SECRET set, a login for an address the proxy
// has no account for yet needs a grant from the operator's own webmail
// (Bulwark, a server entry marked "only as an extra account"). Bulwark issues
// one only to a browser that is signed in to the operator's mail server, and
// sends it from its own server in the X-Bulwark-Login-Grant header of the
// login it checks. Addresses that already have an account sign in as before.
//
// A grant is `bwg1.<payload>.<signature>`: the payload is base64url JSON
// { aud, sub, pri, iat, exp, jti }, the signature base64url HMAC-SHA-256 over
// `bwg1.<payload>` with the shared secret. It is good for one login of `sub`
// at the proxy named by `aud`, for at most five minutes, used once.

import crypto from "node:crypto";
import { b64uDecode, b64uEncode } from "../util/base64url.js";

export const LOGIN_GRANT_HEADER = "x-bulwark-login-grant";
const PREFIX = "bwg1";
/** The longest lifetime a grant may claim. Bulwark issues them for one minute. */
export const MAX_GRANT_LIFETIME_SEC = 300;
/** How far the two servers' clocks may disagree. */
export const CLOCK_SKEW_SEC = 30;
const MAX_TOKEN_LENGTH = 4096;
/** The shortest secret accepted, in bytes. */
export const MIN_SECRET_BYTES = 32;

export interface LoginGrantClaims {
  /** The proxy's public URL. */
  aud: string;
  /** The address being signed in. */
  sub: string;
  /** The webmail account it was issued to, for the log. */
  pri: string;
  iat: number;
  exp: number;
  jti: string;
}

export type GrantCheck = { ok: true; claims: LoginGrantClaims } | { ok: false; reason: string };

/** A URL as grants name it: scheme and host in lower case, no trailing slash. */
export function grantAudience(url: string): string {
  try {
    const u = new URL(url.trim());
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().replace(/\/+$/, "").toLowerCase();
  }
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function sign(secret: Buffer, body: string): string {
  return b64uEncode(crypto.createHmac("sha256", secret).update(body).digest());
}

/** A grant for `claims` (tests and tools; Bulwark builds the same in TypeScript). */
export function issueLoginGrant(secret: Buffer, claims: LoginGrantClaims): string {
  const body = `${PREFIX}.${b64uEncode(Buffer.from(JSON.stringify(claims), "utf8"))}`;
  return `${body}.${sign(secret, body)}`;
}

function parseClaims(json: unknown): LoginGrantClaims | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const c = json as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  const int = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v);
  if (!str(c.aud, 2048) || !str(c.sub, 512) || !(c.pri === undefined || typeof c.pri === "string")) return null;
  if (!int(c.iat) || !int(c.exp) || !str(c.jti, 128) || (c.jti as string).length < 16) return null;
  return { aud: c.aud as string, sub: c.sub as string, pri: (c.pri as string | undefined) ?? "", iat: c.iat as number, exp: c.exp as number, jti: c.jti as string };
}

/** Checks grants for one proxy and remembers the used ones until they expire. */
export class LoginGrants {
  private readonly audience: string;
  /** jti of grants already used, to when they expire (ms). */
  private readonly used = new Map<string, number>();

  constructor(
    private readonly secret: Buffer,
    publicUrl: string,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < MIN_SECRET_BYTES) throw new Error(`a login grant secret needs at least ${MIN_SECRET_BYTES} bytes`);
    this.audience = grantAudience(publicUrl);
  }

  /** Whether `token` is a valid, unused grant for a login of `username`; uses it up when it is. */
  check(token: unknown, username: string): GrantCheck {
    if (typeof token !== "string" || token === "") return { ok: false, reason: "no grant" };
    if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "malformed grant" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: "malformed grant" };
    const expected = Buffer.from(sign(this.secret, `${parts[0]}.${parts[1]}`));
    const given = Buffer.from(parts[2]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return { ok: false, reason: "bad signature" };
    }
    let claims: LoginGrantClaims | null;
    try {
      claims = parseClaims(JSON.parse(b64uDecode(parts[1]).toString("utf8")));
    } catch {
      claims = null;
    }
    if (!claims) return { ok: false, reason: "malformed grant" };
    if (grantAudience(claims.aud) !== this.audience) return { ok: false, reason: "grant for another server" };
    const nowMs = this.now();
    const now = Math.floor(nowMs / 1000);
    if (claims.exp <= claims.iat || claims.exp - claims.iat > MAX_GRANT_LIFETIME_SEC) return { ok: false, reason: "bad lifetime" };
    if (claims.iat > now + CLOCK_SKEW_SEC) return { ok: false, reason: "issued in the future" };
    if (claims.exp < now - CLOCK_SKEW_SEC) return { ok: false, reason: "expired" };
    if (!sameAddress(claims.sub, username)) return { ok: false, reason: "grant for another address" };
    for (const [jti, until] of this.used) if (until < nowMs) this.used.delete(jti);
    if (this.used.has(claims.jti)) return { ok: false, reason: "grant already used" };
    this.used.set(claims.jti, (claims.exp + CLOCK_SKEW_SEC) * 1000);
    return { ok: true, claims };
  }
}

/**
 * `LOGIN_GRANT_SECRET`: unset or empty turns grants off; anything shorter
 * than 32 bytes stops the start.
 */
export function parseLoginGrantSecret(value: string | undefined): Buffer | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const secret = Buffer.from(value.trim(), "utf8");
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(
      `LOGIN_GRANT_SECRET must be at least ${MIN_SECRET_BYTES} characters. ` +
        "Generate one with `openssl rand -base64 32` and set the same value in Bulwark.",
    );
  }
  return secret;
}
