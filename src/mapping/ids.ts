import { b64uDecode, b64uEncode, varintDecode, varintEncode } from "../util/base64url.js";

export interface EmailIdParts {
  accountIdx: number;
  mailboxIdx: number;
  uidvalidity: number;
  uid: number;
}

export interface MailboxIdParts {
  accountIdx: number;
  mailboxIdx: number;
}

export function encodeMailboxId(p: MailboxIdParts): string {
  return b64uEncode(Buffer.concat([varintEncode(p.accountIdx), varintEncode(p.mailboxIdx)]));
}

export function decodeMailboxId(id: string): MailboxIdParts {
  const buf = b64uDecode(id);
  const a = varintDecode(buf, 0);
  const m = varintDecode(buf, a.next);
  if (m.next !== buf.length) throw new Error("decodeMailboxId: trailing bytes");
  return { accountIdx: a.value, mailboxIdx: m.value };
}

export function encodeEmailId(p: EmailIdParts): string {
  return b64uEncode(
    Buffer.concat([
      varintEncode(p.accountIdx),
      varintEncode(p.mailboxIdx),
      varintEncode(p.uidvalidity),
      varintEncode(p.uid),
    ]),
  );
}

export function decodeEmailId(id: string): EmailIdParts {
  const buf = b64uDecode(id);
  const a = varintDecode(buf, 0);
  const m = varintDecode(buf, a.next);
  const v = varintDecode(buf, m.next);
  const u = varintDecode(buf, v.next);
  if (u.next !== buf.length) throw new Error("decodeEmailId: trailing bytes");
  return { accountIdx: a.value, mailboxIdx: m.value, uidvalidity: v.value, uid: u.value };
}

export function encodeBlobId(emailId: string, partId?: string): string {
  return partId ? `P${emailId}:${partId}` : `E${emailId}`;
}

export function decodeBlobId(blobId: string): { emailId: string; partId: string | null } {
  if (blobId.startsWith("E")) return { emailId: blobId.slice(1), partId: null };
  if (blobId.startsWith("P")) {
    const colon = blobId.indexOf(":");
    if (colon < 2) throw new Error("decodeBlobId: bad part blob");
    return { emailId: blobId.slice(1, colon), partId: blobId.slice(colon + 1) };
  }
  throw new Error("decodeBlobId: unknown prefix");
}
