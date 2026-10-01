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

// Format: [12-byte nonce | 16-byte tag | ciphertext]
const NONCE_LEN = 12;
const TAG_LEN = 16;

/** Encrypts arbitrary bytes under the vault key, in the layout described above. */
export function seal(key: Buffer, plain: Buffer): Buffer {
  if (key.length !== 32) throw new Error("vault key must be 32 bytes");
  const nonce = crypto.randomBytes(NONCE_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]);
}

/** Decrypts what {@link seal} produced. Throws if the key is wrong or the bytes were altered. */
export function unseal(key: Buffer, sealed: Buffer): Buffer {
  if (key.length !== 32) throw new Error("vault key must be 32 bytes");
  if (sealed.length < NONCE_LEN + TAG_LEN) throw new Error("vault: truncated");
  const nonce = sealed.subarray(0, NONCE_LEN);
  const tag = sealed.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(sealed.subarray(NONCE_LEN + TAG_LEN)),
    decipher.final(),
  ]);
}

export async function sealCredentials(key: Buffer, c: Credentials): Promise<Buffer> {
  return seal(key, Buffer.from(JSON.stringify(c), "utf8"));
}

export async function openCredentials(key: Buffer, vault: Buffer): Promise<Credentials> {
  if (vault.length < NONCE_LEN + TAG_LEN) throw new Error("vault: truncated");
  return JSON.parse(unseal(key, vault).toString("utf8")) as Credentials;
}
