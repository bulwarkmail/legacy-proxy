import type { FetchMessageObject, ImapFlow } from "imapflow";
// libqp ships no types; we only use `decode(string) => Buffer`.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no declaration file
import libqp from "libqp";
import { selectBodies, structureToBodyParts, type EmailBodyPart } from "../mapping/structure.js";
import { flagsToKeywords } from "../mapping/flags.js";
import { encodeBlobId, encodeEmailId, encodeMailboxId } from "../mapping/ids.js";
import { parseHeaderBlock, asMessageIds, computeThreadIdFromHeaders, type ParsedHeader } from "./headers.js";
import type { AccountRow, MailboxRow, Store, EmailCacheUpsert } from "../state/store.js";

// The header fields threading and the default Email/get property set need:
// References for threadId + `references`, In-Reply-To / Message-ID as backup.
// Everything else in the header block (Received chains, ARC/DKIM signatures —
// often 5-20 KB per message) is dead weight unless the client asked for a
// `header:*` projection, so we only pull the full block on demand.
export const THREAD_HEADER_FIELDS = ["message-id", "in-reply-to", "references"];

function metaQuery(fullHeaders: boolean) {
  return {
    uid: true as const,
    flags: true as const,
    size: true as const,
    internalDate: true as const,
    envelope: true as const,
    bodyStructure: true as const,
    headers: fullHeaders ? (true as const) : THREAD_HEADER_FIELDS,
  };
}

export interface JmapEmail {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, true>;
  keywords: Record<string, true>;
  size: number;
  receivedAt: string;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: { name: string | null; email: string }[] | null;
  from: { name: string | null; email: string }[] | null;
  to: { name: string | null; email: string }[] | null;
  cc: { name: string | null; email: string }[] | null;
  bcc: { name: string | null; email: string }[] | null;
  replyTo: { name: string | null; email: string }[] | null;
  subject: string | null;
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
  bodyStructure: ReturnType<typeof structureToBodyParts>;
  textBody: ReturnType<typeof selectBodies>["textBody"];
  htmlBody: ReturnType<typeof selectBodies>["htmlBody"];
  attachments: ReturnType<typeof selectBodies>["attachments"];
  bodyValues: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }>;
  // The parsed RFC 5322 header block. Internal-only; Email/get strips this
  // before serialising and the JMAP client never sees it.
  _headers: ParsedHeader[];
}

export interface BodyFetchOpts {
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: number;
  // When false, skip the per-batch preview FETCH. Email/get callers that
  // don't request `preview` in `properties` set this to avoid an extra IMAP
  // round trip on every page of a folder list. Defaults to true (legacy
  // behaviour) for callers that don't pass `properties`.
  wantsPreview?: boolean;
  // True when the client requested a `header:*` projection, which needs the
  // complete header block rather than the threading subset.
  needsFullHeaders?: boolean;
}

function decodePartText(buf: Buffer, charset: string | null): string {
  const cs = (charset ?? "utf-8").toLowerCase();
  try {
    return new TextDecoder(cs, { fatal: false }).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

// IMAP `BODY[partId]` returns the raw bytes - still in their Content-Transfer
// -Encoding (typically quoted-printable or base64 for text parts). imapflow's
// `download()` decodes that for us, but `fetch({bodyParts})` does not, so we
// must reverse the CTE ourselves before applying the charset.
function decodeTransferEncoding(buf: Buffer, encoding: string | null): Buffer {
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "quoted-printable") {
    try {
      return libqp.decode(buf.toString("binary"));
    } catch {
      return buf;
    }
  }
  if (enc === "base64") {
    try {
      // Strip CR/LF so partial-line base64 still decodes cleanly.
      return Buffer.from(buf.toString("binary").replace(/[\r\n]/g, ""), "base64");
    } catch {
      return buf;
    }
  }
  // 7bit, 8bit, binary, or unspecified: no transform.
  return buf;
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(p|div|br|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function addr(list: { name?: string | null; address?: string | null }[] | null | undefined) {
  if (!list || list.length === 0) return null;
  return list
    .filter((a) => a.address)
    .map((a) => ({ name: a.name?.trim() || null, email: a.address! }));
}

// Bytes of body text to fetch for the preview snippet. JMAP previews cap at
// 256 chars; pulling a few KB tolerates multi-byte charsets, quoted-printable
// expansion, and HTML markup overhead before the htmlToPlain step.
const PREVIEW_FETCH_BYTES = 4096;

function buildPreview(text: string, isHtml: boolean): string {
  const plain = isHtml ? htmlToPlain(text) : text;
  return plain.replace(/\s+/g, " ").trim().slice(0, 256);
}

// Envelope as imapflow parses it. When rehydrated from the cache the Date
// fields come back as ISO strings — every consumer feeds them to `new Date()`,
// which accepts both.
interface EnvelopeLike {
  date?: Date | string;
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  sender?: { name?: string | null; address?: string | null }[];
  from?: { name?: string | null; address?: string | null }[];
  to?: { name?: string | null; address?: string | null }[];
  cc?: { name?: string | null; address?: string | null }[];
  bcc?: { name?: string | null; address?: string | null }[];
  replyTo?: { name?: string | null; address?: string | null }[];
}

// The immutable per-message facts, either fresh off a FETCH or rehydrated
// from the email_cache table. `flags` is null until fetched — it's the one
// mutable attribute and is never served from the cache.
interface RawMeta {
  uid: number;
  flags: Set<string> | null;
  size: number;
  internaldate: number;
  envelope: EnvelopeLike | null;
  bodystructure: unknown;
  headersRaw: Buffer;
  headersFull: boolean;
  preview: string | null;
  fromCache: boolean;
}

interface ProcessedMeta {
  raw: RawMeta;
  emailId: string;
  blobId: string;
  threadId: string;
  root: EmailBodyPart;
  sel: ReturnType<typeof selectBodies>;
  headers: ParsedHeader[];
}

function headersToBuffer(headers: FetchMessageObject["headers"]): Buffer {
  if (Buffer.isBuffer(headers)) return headers;
  if (typeof headers === "string") return Buffer.from(headers, "utf8");
  return Buffer.alloc(0);
}

function rawFromFetch(msg: FetchMessageObject, headersFull: boolean): RawMeta {
  return {
    uid: msg.uid!,
    flags: new Set(msg.flags ?? []),
    size: msg.size ?? 0,
    internaldate: msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
    envelope: (msg.envelope as EnvelopeLike | undefined) ?? null,
    bodystructure: msg.bodyStructure ?? null,
    headersRaw: headersToBuffer(msg.headers),
    headersFull,
    preview: null,
    fromCache: false,
  };
}

function processMeta(account: AccountRow, mailbox: MailboxRow, raw: RawMeta): ProcessedMeta {
  const emailId = encodeEmailId({
    accountIdx: account.id,
    mailboxIdx: mailbox.id,
    uidvalidity: mailbox.uidvalidity,
    uid: raw.uid,
  });
  const blobId = encodeBlobId(emailId);
  const root = structureToBodyParts(raw.bodystructure as never, (partId) =>
    partId ? encodeBlobId(emailId, partId) : blobId,
  );
  const sel = selectBodies(root);
  const headers = parseHeaderBlock(raw.headersRaw);
  const threadId =
    computeThreadIdFromHeaders(headers, raw.envelope?.messageId ?? null) ?? emailId;
  return { raw, emailId, blobId, threadId, root, sel, headers };
}

function assembleEmail(
  account: AccountRow,
  mailbox: MailboxRow,
  p: ProcessedMeta,
  preview: string,
  bodyValues: JmapEmail["bodyValues"],
): JmapEmail {
  const env = p.raw.envelope;
  const referencesIds = asMessageIds(p.headers, "References");
  return {
    id: p.emailId,
    blobId: p.blobId,
    threadId: p.threadId,
    mailboxIds: {
      [encodeMailboxId({ accountIdx: account.id, mailboxIdx: mailbox.id })]: true,
    },
    keywords: flagsToKeywords(Array.from(p.raw.flags ?? [])),
    size: p.raw.size,
    receivedAt: new Date(p.raw.internaldate).toISOString(),
    messageId: env?.messageId ? [stripBrackets(env.messageId)] : null,
    inReplyTo: env?.inReplyTo ? [stripBrackets(env.inReplyTo)] : null,
    references: referencesIds,
    sender: addr(env?.sender),
    from: addr(env?.from),
    to: addr(env?.to),
    cc: addr(env?.cc),
    bcc: addr(env?.bcc),
    replyTo: addr(env?.replyTo),
    subject: env?.subject ?? null,
    sentAt: env?.date ? new Date(env.date).toISOString() : null,
    hasAttachment: p.sel.hasAttachment,
    preview,
    bodyStructure: p.root,
    textBody: p.sel.textBody,
    htmlBody: p.sel.htmlBody,
    attachments: p.sel.attachments,
    bodyValues,
    _headers: p.headers,
  };
}

// Which body parts a message needs fetched to satisfy the bodyValues options.
function wantedBodyParts(sel: ReturnType<typeof selectBodies>, opts: BodyFetchOpts): Map<string, EmailBodyPart> {
  const wanted = new Map<string, EmailBodyPart>();
  const includeAll = opts.fetchAllBodyValues === true;
  if (opts.fetchTextBodyValues || includeAll) {
    for (const part of sel.textBody) if (part.partId) wanted.set(part.partId, part);
  }
  if (opts.fetchHTMLBodyValues || includeAll) {
    for (const part of sel.htmlBody) if (part.partId) wanted.set(part.partId, part);
  }
  if (includeAll) {
    for (const part of sel.attachments) {
      if (part.partId && part.type.startsWith("text/")) wanted.set(part.partId, part);
    }
  }
  return wanted;
}

// Fetch bodyValues for many messages, batching one FETCH per distinct
// part-id set instead of one FETCH per message. Sibling messages in a thread
// almost always share the same MIME shape ("1" or "1.1"+"1.2"), so an open
// thread of N messages collapses to one or two round trips.
async function fetchBodyValuesBatched(
  client: ImapFlow,
  items: { uid: number; wanted: Map<string, EmailBodyPart> }[],
  opts: BodyFetchOpts,
): Promise<Map<number, JmapEmail["bodyValues"]>> {
  const cap = opts.maxBodyValueBytes ?? 256_000;
  const out = new Map<number, JmapEmail["bodyValues"]>();
  const groups = new Map<string, { partIds: string[]; members: typeof items }>();
  for (const item of items) {
    if (item.wanted.size === 0) {
      out.set(item.uid, {});
      continue;
    }
    const partIds = [...item.wanted.keys()].sort();
    const key = partIds.join(",");
    let g = groups.get(key);
    if (!g) {
      g = { partIds, members: [] };
      groups.set(key, g);
    }
    g.members.push(item);
  }

  for (const g of groups.values()) {
    const byUid = new Map(g.members.map((m) => [m.uid, m]));
    const rawByUid = new Map<number, Map<string, Buffer>>();
    try {
      for await (const msg of client.fetch(
        g.members.map((m) => m.uid),
        { uid: true, bodyParts: g.partIds },
        { uid: true },
      )) {
        if (msg.uid != null && msg.bodyParts) rawByUid.set(msg.uid, msg.bodyParts);
      }
    } catch {
      // fall through: members without raw parts get isEncodingProblem below
    }
    for (const m of g.members) {
      const bodyParts = rawByUid.get(m.uid);
      const values: JmapEmail["bodyValues"] = {};
      for (const [partId, part] of byUid.get(m.uid)!.wanted) {
        const raw = bodyParts?.get(partId);
        if (!raw) {
          values[partId] = { value: "", isEncodingProblem: true, isTruncated: false };
          continue;
        }
        const decoded = decodeTransferEncoding(raw, part.encoding);
        const truncated = decoded.length > cap;
        const slice = truncated ? decoded.subarray(0, cap) : decoded;
        values[partId] = {
          value: decodePartText(slice, part.charset),
          isEncodingProblem: false,
          isTruncated: truncated,
        };
      }
      out.set(m.uid, values);
    }
  }
  return out;
}

// Fetch preview snippets for the given messages, batching one FETCH per
// distinct first-text-part id (typically one or two groups per page).
async function fetchPreviewsBatched(
  client: ImapFlow,
  targets: ProcessedMeta[],
): Promise<Map<number, string>> {
  interface PreviewTask {
    uid: number;
    partId: string;
    encoding: string | null;
    charset: string | null;
    isHtml: boolean;
  }
  const out = new Map<number, string>();
  const tasks: PreviewTask[] = [];
  for (const p of targets) {
    const text = p.sel.textBody.find((b) => b.partId);
    const html = p.sel.htmlBody.find((b) => b.partId);
    const part = text ?? html;
    if (!part?.partId) {
      // No previewable part at all: the empty preview is final, cacheable.
      out.set(p.raw.uid, "");
      continue;
    }
    tasks.push({
      uid: p.raw.uid,
      partId: part.partId,
      encoding: part.encoding,
      charset: part.charset,
      isHtml: !text,
    });
  }
  const byPartId = new Map<string, PreviewTask[]>();
  for (const t of tasks) {
    let arr = byPartId.get(t.partId);
    if (!arr) {
      arr = [];
      byPartId.set(t.partId, arr);
    }
    arr.push(t);
  }
  for (const [partId, group] of byPartId) {
    const taskByUid = new Map(group.map((t) => [t.uid, t]));
    try {
      for await (const m of client.fetch(
        group.map((t) => t.uid),
        { uid: true, bodyParts: [{ key: partId, start: 0, maxLength: PREVIEW_FETCH_BYTES }] },
        { uid: true },
      )) {
        if (m.uid == null) continue;
        const buf = m.bodyParts?.get(partId);
        if (!buf) continue;
        const t = taskByUid.get(m.uid);
        if (!t) continue;
        const decoded = decodeTransferEncoding(buf, t.encoding);
        out.set(m.uid, buildPreview(decodePartText(decoded, t.charset), t.isHtml));
      }
    } catch {
      // best-effort: leave preview empty (and uncached) for this group
    }
  }
  return out;
}

// Bulk fetch: serve immutable metadata from the SQLite cache when a Store is
// supplied, FETCH only the cache misses (plus one cheap flags-only FETCH for
// the hits, since flags are mutable), then batch previews and bodyValues
// across the whole page. Returns a Map keyed by uid so callers can match
// notFound by id.
export async function fetchEmailsBatch(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  uids: number[],
  bodyOpts: BodyFetchOpts = {},
  store?: Store,
): Promise<Map<number, JmapEmail>> {
  const out = new Map<number, JmapEmail>();
  if (uids.length === 0) return out;
  const needsFull = bodyOpts.needsFullHeaders === true;

  const cachedRows = store
    ? store.getEmailCacheRows(account.id, mailbox.id, mailbox.uidvalidity, uids)
    : new Map<number, never>();
  const raws = new Map<number, RawMeta>();
  const missing: number[] = [];
  for (const uid of uids) {
    const row = cachedRows.get(uid);
    if (
      row &&
      row.envelope !== null &&
      row.bodystructure !== null &&
      row.headers_raw !== null &&
      (!needsFull || row.headers_full === 1)
    ) {
      try {
        raws.set(uid, {
          uid,
          flags: null,
          size: row.size ?? 0,
          internaldate: row.internaldate,
          envelope: JSON.parse(row.envelope) as EnvelopeLike,
          bodystructure: JSON.parse(row.bodystructure),
          headersRaw: Buffer.isBuffer(row.headers_raw) ? row.headers_raw : Buffer.from(row.headers_raw),
          headersFull: row.headers_full === 1,
          preview: row.preview,
          fromCache: true,
        });
        continue;
      } catch {
        // corrupt cache row: fall through to a live fetch
      }
    }
    missing.push(uid);
  }

  if (missing.length > 0) {
    for await (const m of client.fetch(missing, metaQuery(needsFull), { uid: true })) {
      if (m.uid == null) continue;
      raws.set(m.uid, rawFromFetch(m, needsFull));
    }
  }

  // Flags for cache-served messages: one flags-only FETCH for the whole set.
  const flagUids = uids.filter((uid) => raws.get(uid)?.flags === null);
  if (flagUids.length > 0) {
    for await (const m of client.fetch(flagUids, { uid: true, flags: true }, { uid: true })) {
      if (m.uid == null) continue;
      const r = raws.get(m.uid);
      if (r) r.flags = new Set(m.flags ?? []);
    }
  }

  const processed: ProcessedMeta[] = [];
  for (const uid of uids) {
    const r = raws.get(uid);
    // A cache hit whose flags FETCH returned nothing means the message was
    // expunged; drop it (and the stale row) so the caller reports notFound.
    if (!r || (r.fromCache && r.flags === null)) {
      if (r && store) store.deleteEmailCacheUids(account.id, mailbox.id, [uid]);
      continue;
    }
    processed.push(processMeta(account, mailbox, r));
  }

  const wantsBodies =
    bodyOpts.fetchTextBodyValues === true ||
    bodyOpts.fetchHTMLBodyValues === true ||
    bodyOpts.fetchAllBodyValues === true;
  const wantsPreview = bodyOpts.wantsPreview !== false;

  let bodyValuesByUid = new Map<number, JmapEmail["bodyValues"]>();
  if (wantsBodies) {
    bodyValuesByUid = await fetchBodyValuesBatched(
      client,
      processed.map((p) => ({ uid: p.raw.uid, wanted: wantedBodyParts(p.sel, bodyOpts) })),
      bodyOpts,
    );
  }

  const previewByUid = new Map<number, string>();
  for (const p of processed) {
    if (p.raw.preview !== null) previewByUid.set(p.raw.uid, p.raw.preview);
  }
  if (wantsPreview) {
    if (wantsBodies) {
      // Derive previews from the body values we already have in hand.
      for (const p of processed) {
        if (previewByUid.has(p.raw.uid)) continue;
        const values = bodyValuesByUid.get(p.raw.uid) ?? {};
        let preview = "";
        const firstText = p.sel.textBody[0]?.partId;
        if (firstText && values[firstText]) preview = buildPreview(values[firstText].value, false);
        if (!preview) {
          const firstHtml = p.sel.htmlBody[0]?.partId;
          if (firstHtml && values[firstHtml]) preview = buildPreview(values[firstHtml].value, true);
        }
        if (preview) previewByUid.set(p.raw.uid, preview);
      }
    }
    const needPreview = processed.filter((p) => !previewByUid.has(p.raw.uid));
    if (needPreview.length > 0) {
      const fetched = await fetchPreviewsBatched(client, needPreview);
      for (const [uid, preview] of fetched) previewByUid.set(uid, preview);
    }
    // Persist previews computed for rows that were served from cache without
    // one; fresh rows get theirs in the upsert below.
    if (store) {
      for (const p of processed) {
        if (!p.raw.fromCache || p.raw.preview !== null) continue;
        const preview = previewByUid.get(p.raw.uid);
        if (preview !== undefined) store.setEmailCachePreview(account.id, mailbox.id, p.raw.uid, preview);
      }
    }
  }

  if (store) {
    const upserts: EmailCacheUpsert[] = [];
    for (const p of processed) {
      if (p.raw.fromCache) continue;
      upserts.push({
        accountId: account.id,
        mailboxId: mailbox.id,
        uidvalidity: mailbox.uidvalidity,
        uid: p.raw.uid,
        threadId: p.threadId,
        internaldate: p.raw.internaldate,
        size: p.raw.size,
        envelope: JSON.stringify(p.raw.envelope),
        bodystructure: JSON.stringify(p.raw.bodystructure),
        headersRaw: p.raw.headersRaw,
        headersFull: p.raw.headersFull,
        preview: previewByUid.get(p.raw.uid) ?? null,
      });
    }
    store.upsertEmailCacheRows(upserts);
  }

  for (const p of processed) {
    out.set(
      p.raw.uid,
      assembleEmail(
        account,
        mailbox,
        p,
        previewByUid.get(p.raw.uid) ?? "",
        bodyValuesByUid.get(p.raw.uid) ?? {},
      ),
    );
  }
  return out;
}

function stripBrackets(s: string): string {
  return s.replace(/^<|>$/g, "");
}
