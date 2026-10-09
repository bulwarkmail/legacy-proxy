// Read a blob's bytes for building a message: uploads from SQLite, mail parts
// from the blob cache or else an IMAP fetch - the lookup the download route
// does, buffered instead of streamed.

import type { ImapFlow } from "imapflow";
import { Buffer } from "node:buffer";
import { withMailbox } from "../imap/client.js";
import { decodeBlobId, decodeEmailId } from "../mapping/ids.js";
import type { AccountRow, Store } from "../state/store.js";

export async function readBlob(
  blobId: string,
  ctx: { account: AccountRow; store: Store; client: ImapFlow },
): Promise<{ body: Buffer; ctype: string } | null> {
  if (blobId.startsWith("U")) return ctx.store.getUpload(blobId, ctx.account.id);
  const cached = ctx.store.getCachedBlob(blobId, ctx.account.id);
  if (cached) return { body: cached.body, ctype: cached.ctype ?? "application/octet-stream" };

  let part: { emailId: string; partId: string | null };
  let email: { mailboxIdx: number; uid: number };
  try {
    part = decodeBlobId(blobId);
    email = decodeEmailId(part.emailId);
  } catch {
    return null;
  }
  const mbox = ctx.store
    .prep(`SELECT id,name FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(email.mailboxIdx, ctx.account.id) as { id: number; name: string } | undefined;
  if (!mbox) return null;

  return withMailbox(ctx.client, mbox.name, async () => {
    const dl = await ctx.client.download(`${email.uid}`, part.partId ?? undefined, { uid: true });
    // imapflow answers `{}` rather than null for an expunged message or part.
    if (!dl?.content) return null;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of dl.content) chunks.push(chunk as Buffer);
    } catch (e) {
      // A FETCH that broke off mid-literal leaves the connection
      // unparseable, so drop it rather than pool it.
      ctx.client.close();
      throw e;
    }
    return {
      body: Buffer.concat(chunks),
      ctype: part.partId ? dl.meta?.contentType ?? "application/octet-stream" : "message/rfc822",
    };
  });
}
