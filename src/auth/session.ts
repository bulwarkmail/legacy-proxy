import crypto from "node:crypto";
import { b64uDecode, b64uEncode } from "../util/base64url.js";

export interface SessionToken {
  accountSlug: string;
  username: string;
  iat: number;
  exp: number;
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

export function makeSession(opts: { accountSlug: string; username: string; ttlSec?: number }): SessionToken {
  const now = Math.floor(Date.now() / 1000);
  return {
    accountSlug: opts.accountSlug,
    username: opts.username,
    iat: now,
    exp: now + (opts.ttlSec ?? 60 * 60 * 24 * 7),
  };
}
