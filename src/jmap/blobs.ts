// Read a blob's bytes for building a message: uploads from SQLite, mail parts
// from the blob cache or else an IMAP fetch - the lookup the download route
// does, buffered instead of streamed.

import type { ImapFlow } from "imapflow";
import { Buffer } from "node:buffer";
import { withMailbox } from "../imap/client.js";
import type { ImapPool } from "../imap/pool.js";
import { decodeBlobId, decodeEmailId } from "../mapping/ids.js";
import type { AccountRow, Store } from "../state/store.js";
import { log } from "../util/log.js";

// Blob cache bounds, shared with the download route and set from the config
// at start (BLOB_CACHE_*). The total cap keeps the database file bounded; the
// TTL keeps a deleted message's parts from lingering past the week a composer
// might reasonably stay open; parts over maxPartBytes that readBlob fetches
// are used but not kept.
export interface BlobCacheLimits {
  maxTotalBytes: number;
  maxPartBytes: number;
  ttlMs: number;
}

export const DEFAULT_BLOB_CACHE_LIMITS: BlobCacheLimits = {
  maxTotalBytes: 256 * 1024 * 1024,
  maxPartBytes: 50_000_000,
  ttlMs: 7 * 24 * 60 * 60_000,
};

let limits: BlobCacheLimits = DEFAULT_BLOB_CACHE_LIMITS;

export function configureBlobCache(l: BlobCacheLimits): void {
  limits = l;
}

export function blobCacheLimits(): BlobCacheLimits {
  return limits;
}

/**
 * With `limit`, a mail part longer than that is not fetched whole: the read
 * stops one byte past it, so the caller sees a body over the limit and must
 * not use it. Uploads and cached blobs are already held and come back as
 * they are.
 */
export async function readBlob(
  blobId: string,
  ctx: { account: AccountRow; store: Store; client: ImapFlow; pool?: ImapPool },
  limit?: number,
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

  const fetch = (client: ImapFlow) =>
    withMailbox(client, mbox.name, async () => {
      const dl = await client.download(`${email.uid}`, part.partId ?? undefined, {
        uid: true,
        ...(limit === undefined ? {} : { maxBytes: limit + 1 }),
      });
      // imapflow answers `{}` rather than null for an expunged message or part.
      if (!dl?.content) return null;
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of dl.content) chunks.push(chunk as Buffer);
      } catch (e) {
        // A FETCH that broke off mid-literal leaves the connection
        // unparseable, so drop it rather than pool it.
        client.close();
        throw e;
      }
      return {
        body: Buffer.concat(chunks),
        ctype: part.partId ? dl.meta?.contentType ?? "application/octet-stream" : "message/rfc822",
      };
    });
  // Like the download route, fetch on the bulk connection so a large
  // forwarded attachment doesn't hold up the account's interactive calls.
  const blob = await (ctx.pool ? ctx.pool.withConnection(ctx.account, "bulk", fetch) : fetch(ctx.client));
  if (blob) keepBlob(blobId, blob, ctx);
  return blob;
}

// A part blobId names a message, and IMAP has no way to change a message: a
// draft saved again is a new message, and the version it replaces is deleted.
// The webmail keeps the blobIds it read from the draft it opened, so the save
// after that references parts of a message that no longer exists. Keeping
// every part we fetched under its blobId answers those saves (and downloads)
// from the cache instead of failing them with blobNotFound. The bytes are in
// memory already, so the cap here is maxPartBytes, not the download route's
// streaming threshold.
function keepBlob(blobId: string, blob: { body: Buffer; ctype: string }, ctx: { account: AccountRow; store: Store }): void {
  if (limits.maxPartBytes <= 0 || blob.body.length > limits.maxPartBytes) return;
  try {
    ctx.store.putCachedBlob({ id: blobId, accountId: ctx.account.id, ctype: blob.ctype, body: blob.body, ttlMs: limits.ttlMs });
    ctx.store.pruneBlobCache(limits.maxTotalBytes);
  } catch (e) {
    // Best-effort, like the download route's cache write.
    log.warn({ err: (e as Error).message }, "blob cache write failed");
  }
}
