import crypto from "node:crypto";

export interface Credentials {
  mech: "PLAIN" | "LOGIN" | "XOAUTH2";
  username: string;
  password?: string;
  accessToken?: string;
  refreshToken?: string;
  /** OAuth access-token expiry in epoch milliseconds. */
  expiresAt?: number;
  scopes?: string[];
}

/**
 * Where a sealed value is stored. A value opens only in the place it was
 * sealed for: copied to another account's row, or to another row of the same
 * account, it fails to open like a value sealed under another key.
 */
export interface SealPlace {
  /** The table that holds the value. Each table has a key of its own, derived from VAULT_KEY. */
  table: string;
  /** The account the row belongs to: its address, or the account row's slug. */
  account: string;
  /** The row's key within the account, for tables that hold more than one row per account. */
  key?: string;
}

/** The places of the values the proxy seals, one per table. */
export const sealPlace = {
  /** IMAP backend: the stored mail credentials of an account row (`vault`, and `cred_check_vault` of the same row). */
  account: (slug: string): SealPlace => ({ table: "account", account: slug }),
  /** Gmail backend: the stored Google grant of an account. */
  gmailConnection: (email: string): SealPlace => ({ table: "gmail_connection", account: email }),
  /** Gmail backend: one cache entry. */
  gmailCache: (email: string, key: string): SealPlace => ({ table: "gmail_cache", account: email, key }),
  /** Gmail backend: one uploaded file. */
  gmailUpload: (email: string, id: string): SealPlace => ({ table: "gmail_upload", account: email, key: id }),
};

// Current format: [0x02 | 12-byte nonce | 16-byte tag | ciphertext], AES-256-GCM
// under a key derived from the vault key for the place's table (HKDF-SHA256),
// with the place as associated data.
// Earlier format, read but no longer written: [12-byte nonce | 16-byte tag |
// ciphertext] under the vault key itself, without associated data.
const VERSION = 0x02;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const OPEN_FAILED = "vault: cannot open a sealed value (VAULT_KEY is not the one it was sealed with, or the value was altered or moved)";

const derivedKeys = new WeakMap<Buffer, Map<string, Buffer>>();
function tableKey(key: Buffer, table: string): Buffer {
  let keys = derivedKeys.get(key);
  if (!keys) {
    keys = new Map();
    derivedKeys.set(key, keys);
  }
  let derived = keys.get(table);
  if (!derived) {
    derived = Buffer.from(crypto.hkdfSync("sha256", key, Buffer.alloc(0), `legacy-proxy seal: ${table}`, 32));
    keys.set(table, derived);
  }
  return derived;
}
// JSON keeps the parts apart whatever characters an address or key holds.
const associatedData = (place: SealPlace) =>
  Buffer.from(JSON.stringify([VERSION, place.table, place.account, place.key ?? ""]), "utf8");

function checkKey(key: Buffer): void {
  if (key.length !== 32) throw new Error("vault key must be 32 bytes");
}

/** Encrypts arbitrary bytes for one place, in the current format described above. */
export function seal(key: Buffer, place: SealPlace, plain: Buffer): Buffer {
  checkKey(key);
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", tableKey(key, place.table), nonce);
  cipher.setAAD(associatedData(place));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.of(VERSION), nonce, cipher.getAuthTag(), ct]);
}

function decrypt(key: Buffer, body: Buffer, aad: Buffer | null): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, body.subarray(0, NONCE_LEN));
  decipher.setAuthTag(body.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN));
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(body.subarray(NONCE_LEN + TAG_LEN)), decipher.final()]);
}

/**
 * Decrypts a value sealed for `place`. A value in the earlier format opens
 * with the vault key itself; `legacy` says so, and the caller writes it again
 * in the current format. Throws if the key is wrong, the bytes were altered,
 * or the value belongs to another place.
 */
export function unsealValue(key: Buffer, place: SealPlace, sealed: Buffer): { plain: Buffer; legacy: boolean } {
  checkKey(key);
  if (sealed.length < NONCE_LEN + TAG_LEN) throw new Error("vault: truncated");
  if (sealed[0] === VERSION && sealed.length >= 1 + NONCE_LEN + TAG_LEN) {
    try {
      return { plain: decrypt(tableKey(key, place.table), sealed.subarray(1), associatedData(place)), legacy: false };
    } catch {
      // An earlier-format value can start with the same byte: try that next.
    }
  }
  try {
    return { plain: decrypt(key, sealed, null), legacy: true };
  } catch {
    throw new Error(OPEN_FAILED);
  }
}

/** Decrypts what {@link seal} produced for `place`, or a value in the earlier format. */
export function unseal(key: Buffer, place: SealPlace, sealed: Buffer): Buffer {
  return unsealValue(key, place, sealed).plain;
}

export async function sealCredentials(key: Buffer, place: SealPlace, c: Credentials): Promise<Buffer> {
  return seal(key, place, Buffer.from(JSON.stringify(c), "utf8"));
}

export async function openCredentials(key: Buffer, place: SealPlace, vault: Buffer): Promise<Credentials> {
  return JSON.parse(unseal(key, place, vault).toString("utf8")) as Credentials;
}

/** The mail credentials stored in an IMAP backend account row. */
export async function openAccountCredentials(key: Buffer, row: { slug: string; vault: Buffer }): Promise<Credentials> {
  return openCredentials(key, sealPlace.account(row.slug), row.vault);
}
