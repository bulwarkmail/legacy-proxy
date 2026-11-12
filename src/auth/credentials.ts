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
// Earlier format: [12-byte nonce | 16-byte tag | ciphertext] under the vault
// key itself, without associated data. It is opened only once, by the rewrite
// at the first start of a database (planSealedValues); afterwards a value in
// that format opens nowhere.
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

/** True when `value` is laid out like a value sealed in the current format (says nothing about where it opens). */
export function inCurrentForm(value: Buffer): boolean {
  return value.length >= 1 + NONCE_LEN + TAG_LEN && value[0] === VERSION;
}

function decrypt(key: Buffer, body: Buffer, aad: Buffer | null): Buffer {
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, body.subarray(0, NONCE_LEN));
  decipher.setAuthTag(body.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN));
  if (aad) decipher.setAAD(aad);
  return Buffer.concat([decipher.update(body.subarray(NONCE_LEN + TAG_LEN)), decipher.final()]);
}

/**
 * Decrypts what {@link seal} produced for `place`. Throws if the key is wrong,
 * the bytes were altered, the value belongs to another place, or it is in the
 * earlier format.
 */
export function unseal(key: Buffer, place: SealPlace, sealed: Buffer): Buffer {
  checkKey(key);
  if (sealed.length < NONCE_LEN + TAG_LEN) throw new Error("vault: truncated");
  if (!inCurrentForm(sealed)) throw new Error(OPEN_FAILED);
  try {
    return decrypt(tableKey(key, place.table), sealed.subarray(1), associatedData(place));
  } catch {
    throw new Error(OPEN_FAILED);
  }
}

function opens(key: Buffer, place: SealPlace, sealed: Buffer): boolean {
  try {
    unseal(key, place, sealed);
    return true;
  } catch {
    return false;
  }
}

/** A value in the earlier format, or null when it isn't one under this key. Only for the rewrite at start. */
function unsealEarlierForm(key: Buffer, sealed: Buffer): Buffer | null {
  if (sealed.length < NONCE_LEN + TAG_LEN) return null;
  try {
    return decrypt(key, sealed, null);
  } catch {
    return null;
  }
}

/** Thrown when VAULT_KEY doesn't open what a database holds. No row has been changed when it is. */
export class VaultKeyMismatch extends Error {
  constructor(file: string) {
    super(
      `VAULT_KEY does not open the sealed values in ${file}: it is not the key they were sealed with. ` +
        "Start with that key. No row was changed.",
    );
    this.name = "VaultKeyMismatch";
  }
}

// A value each database keeps to tell its key from another one, also when it
// holds no credentials.
const KEY_CHECK_PLACE: SealPlace = { table: "vault_check", account: "", key: "vault key" };
const KEY_CHECK_TEXT = Buffer.from("legacy-proxy vault key", "utf8");

/**
 * What one database's sealed values need when it is opened at start.
 *
 * `check` is the database's key check, null before it has one; `values` are its
 * sealed credentials with their places.
 * - The key must open the key check, or, before there is one, at least one of
 *   the values in either format. Otherwise {@link VaultKeyMismatch} is thrown
 *   and the caller changes nothing.
 * - `firstStart` is true when the database has no key check and no value in the
 *   current format: it was written only by versions that sealed with the vault
 *   key itself. Then `reseal` holds every value that opens in that earlier
 *   format, sealed again for its place. This happens once: later starts find
 *   the key check, and a value in the earlier format opens nowhere.
 * - `check` is the key check to store when the database has none.
 */
export function planSealedValues(
  key: Buffer,
  file: string,
  check: Buffer | null,
  values: { place: SealPlace; value: Buffer }[],
): { firstStart: boolean; reseal: { index: number; value: Buffer }[]; check: Buffer | null } {
  checkKey(key);
  if (check) {
    if (!opens(key, KEY_CHECK_PLACE, check)) throw new VaultKeyMismatch(file);
    return { firstStart: false, reseal: [], check: null };
  }
  const current = values.map((v) => opens(key, v.place, v.value));
  const earlier = values.map((v, i) => (current[i] ? null : unsealEarlierForm(key, v.value)));
  if (values.length > 0 && !current.some(Boolean) && !earlier.some((e) => e !== null)) {
    throw new VaultKeyMismatch(file);
  }
  const firstStart = !current.some(Boolean);
  const reseal = firstStart
    ? earlier.flatMap((plain, index) => (plain ? [{ index, value: seal(key, values[index]!.place, plain) }] : []))
    : [];
  return { firstStart, reseal, check: seal(key, KEY_CHECK_PLACE, KEY_CHECK_TEXT) };
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
