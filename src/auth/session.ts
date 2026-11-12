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
  /**
   * Keyed tag of the credentials the session was made with (see
   * `credentialTag`). Sessions made with the credentials that replaced the
   * stored ones stay valid when the generation moves because of them.
   */
  cf?: string;
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

/**
 * A keyed tag of a credential: the user name, password or OAuth, and the
 * password. Two sign-ins with the same password get the same tag; it reveals
 * nothing about the password without the key.
 */
export function credentialTag(key: Buffer, c: { mech: string; username: string; password?: string }): string {
  const oauth = c.mech === "XOAUTH2";
  const input = ["credential-tag", oauth ? "oauth" : "password", c.username, oauth ? "" : (c.password ?? "")].join("\n");
  return b64uEncode(crypto.createHmac("sha256", key).update(input).digest()).slice(0, 22);
}

/**
 * True when a session issued under `gen`, made with credentials tagged `tag`,
 * is valid for an account at `currentGen`: issued under the current
 * generation, or under the one before with the credentials that moved it
 * (`rotatedBy`).
 */
export function generationValid(gen: number, tag: string | undefined, currentGen: number, rotatedBy: string | null): boolean {
  return gen === currentGen || (gen === currentGen - 1 && !!tag && tag === rotatedBy);
}

export function makeSession(opts: {
  accountSlug: string;
  username: string;
  gen?: number;
  cf?: string;
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
    ...(opts.cf ? { cf: opts.cf } : {}),
  };
}
