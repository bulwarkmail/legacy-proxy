import crypto from "node:crypto";
import { b64uDecode, b64uEncode } from "../util/base64url.js";

export interface SessionToken {
  accountSlug: string;
  username: string;
  iat: number;
  exp: number;
  /**
   * The account's credential generation when the token was issued. Tokens
   * issued before generations existed carry none and count as generation 0.
   */
  gen?: number;
  /** Random per token, so two sign-ins in the same second get tokens that can be ended one by one. */
  sid?: string;
}

/** The credential generation a token was issued under. */
export function sessionGeneration(t: SessionToken): number {
  return typeof t.gen === "number" && Number.isInteger(t.gen) ? t.gen : 0;
}

export function signSession(key: Buffer, t: SessionToken): string {
  const body = b64uEncode(Buffer.from(JSON.stringify(t), "utf8"));
  const sig = b64uEncode(crypto.createHmac("sha256", key).update(body).digest());
  return `${body}.${sig}`;
}

export function verifySession(key: Buffer, token: string): SessionToken | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = b64uEncode(crypto.createHmac("sha256", key).update(body).digest());
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed: SessionToken;
  try {
    parsed = JSON.parse(b64uDecode(body).toString("utf8")) as SessionToken;
  } catch {
    return null;
  }
  if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}

export function makeSession(opts: {
  accountSlug: string;
  username: string;
  gen?: number;
  ttlSec?: number;
}): SessionToken {
  const now = Math.floor(Date.now() / 1000);
  return {
    accountSlug: opts.accountSlug,
    username: opts.username,
    iat: now,
    exp: now + (opts.ttlSec ?? 60 * 60 * 24 * 7),
    gen: opts.gen ?? 0,
    sid: b64uEncode(crypto.randomBytes(12)),
  };
}
