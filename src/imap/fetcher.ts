import type { FetchMessageObject, ImapFlow } from "imapflow";
// libqp ships no types; we only use `decode(string) => Buffer`.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error no declaration file
import libqp from "libqp";
import { selectBodies, structureToBodyParts, type EmailBodyPart } from "../mapping/structure.js";
import { flagsToKeywords } from "../mapping/flags.js";
import { encodeBlobId, encodeEmailId } from "../mapping/ids.js";
import type { AccountRow, MailboxRow } from "../state/store.js";

const META_QUERY = {
  uid: true as const,
  flags: true as const,
  size: true as const,
  internalDate: true as const,
  envelope: true as const,
  bodyStructure: true as const,
  headers: ["Message-ID", "References", "In-Reply-To"],
};

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
}

export interface BodyFetchOpts {
  fetchTextBodyValues?: boolean;
  fetchHTMLBodyValues?: boolean;
  fetchAllBodyValues?: boolean;
  maxBodyValueBytes?: number;
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

async function fetchBodyValues(
  client: ImapFlow,
  uid: number,
  textParts: EmailBodyPart[],
  htmlParts: EmailBodyPart[],
  attachments: EmailBodyPart[],
  opts: BodyFetchOpts,
): Promise<Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }>> {
  const wanted = new Map<string, EmailBodyPart>();
  const cap = opts.maxBodyValueBytes ?? 256_000;
  const includeAll = opts.fetchAllBodyValues === true;
  if (opts.fetchTextBodyValues || includeAll) {
    for (const p of textParts) if (p.partId) wanted.set(p.partId, p);
  }
  if (opts.fetchHTMLBodyValues || includeAll) {
    for (const p of htmlParts) if (p.partId) wanted.set(p.partId, p);
  }
  if (includeAll) {
    for (const p of attachments) {
      if (p.partId && p.type.startsWith("text/")) wanted.set(p.partId, p);
    }
  }
  const out: Record<string, { value: string; isEncodingProblem: boolean; isTruncated: boolean }> = {};
  if (wanted.size === 0) return out;

  // Fetch all wanted body parts in a single FETCH instead of one round-trip
  // per part. For a typical multipart/alternative email this collapses
  // 2+ round-trips into one.
  const partIds = [...wanted.keys()];
  let bodyParts: Map<string, Buffer> | undefined;
  try {
    const msg = await client.fetchOne(
      `${uid}`,
      { uid: true, bodyParts: partIds },
      { uid: true },
    );
    if (msg && msg.bodyParts) bodyParts = msg.bodyParts;
  } catch {
    // fall through and mark all as encoding problems
  }

  for (const [partId, part] of wanted) {
    const raw = bodyParts?.get(partId);
    if (!raw) {
      out[partId] = { value: "", isEncodingProblem: true, isTruncated: false };
      continue;
    }
    const decoded = decodeTransferEncoding(raw, part.encoding);
    const truncated = decoded.length > cap;
    const slice = truncated ? decoded.subarray(0, cap) : decoded;
    const value = decodePartText(slice, part.charset);
    out[partId] = { value, isEncodingProblem: false, isTruncated: truncated };
  }
  return out;
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

// Single-message preview fetch: pulls a small slice of the first text or html
// part. Used by `fetchEmailMeta`; batched callers should use the precomputed
// path on `processMessage` instead to collapse round trips.
async function fetchPreviewSnippet(
  client: ImapFlow,
  uid: number,
  sel: ReturnType<typeof selectBodies>,
): Promise<string> {
  const text = sel.textBody.find((p) => p.partId);
  const html = sel.htmlBody.find((p) => p.partId);
  const part = text ?? html;
  if (!part?.partId) return "";
  try {
    const msg = await client.fetchOne(
      `${uid}`,
      { uid: true, bodyParts: [{ key: part.partId, start: 0, maxLength: PREVIEW_FETCH_BYTES }] },
      { uid: true },
    );
    const buf = msg && msg.bodyParts ? msg.bodyParts.get(part.partId) : undefined;
    if (!buf) return "";
    const decoded = decodeTransferEncoding(buf, part.encoding);
    const decodedText = decodePartText(decoded, part.charset);
    return buildPreview(decodedText, !text);
  } catch {
    return "";
  }
}

async function processMessage(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  msg: FetchMessageObject,
  bodyOpts: BodyFetchOpts,
  precomputedPreview?: string,
): Promise<JmapEmail> {
  const emailId = encodeEmailId({
    accountIdx: account.id,
    mailboxIdx: mailbox.id,
    uidvalidity: mailbox.uidvalidity,
    uid: msg.uid!,
  });
  const blobId = encodeBlobId(emailId);

  const root = structureToBodyParts(msg.bodyStructure as never, (partId) =>
    partId ? encodeBlobId(emailId, partId) : blobId,
  );
  const sel = selectBodies(root);

  const env = msg.envelope ?? null;

  const wantsBodies =
    bodyOpts.fetchTextBodyValues === true ||
    bodyOpts.fetchHTMLBodyValues === true ||
    bodyOpts.fetchAllBodyValues === true;
  const bodyValues = wantsBodies
    ? await fetchBodyValues(client, msg.uid!, sel.textBody, sel.htmlBody, sel.attachments, bodyOpts)
    : {};

  let preview = precomputedPreview ?? "";
  if (!preview && wantsBodies) {
    const firstText = sel.textBody[0]?.partId;
    if (firstText && bodyValues[firstText]) {
      preview = buildPreview(bodyValues[firstText].value, false);
    }
    if (!preview) {
      const firstHtml = sel.htmlBody[0]?.partId;
      if (firstHtml && bodyValues[firstHtml]) {
        preview = buildPreview(bodyValues[firstHtml].value, true);
      }
    }
  }
  // Mail list views request `preview` without `fetchTextBodyValues`; fetch a
  // small slice so the list still shows snippets.
  if (!preview && !wantsBodies && precomputedPreview === undefined) {
    preview = await fetchPreviewSnippet(client, msg.uid!, sel);
  }

  return {
    id: emailId,
    blobId,
    threadId: emailId,
    mailboxIds: { [String(mailbox.id)]: true },
    keywords: flagsToKeywords(Array.from(msg.flags ?? [])),
    size: msg.size ?? 0,
    receivedAt: new Date(msg.internalDate ?? Date.now()).toISOString(),
    messageId: env?.messageId ? [stripBrackets(env.messageId)] : null,
    inReplyTo: env?.inReplyTo ? [stripBrackets(env.inReplyTo)] : null,
    references: null,
    sender: addr(env?.sender as never),
    from: addr(env?.from as never),
    to: addr(env?.to as never),
    cc: addr(env?.cc as never),
    bcc: addr(env?.bcc as never),
    replyTo: addr(env?.replyTo as never),
    subject: env?.subject ?? null,
    sentAt: env?.date ? new Date(env.date).toISOString() : null,
    hasAttachment: sel.hasAttachment,
    preview,
    bodyStructure: root,
    textBody: sel.textBody,
    htmlBody: sel.htmlBody,
    attachments: sel.attachments,
    bodyValues,
  };
}

export async function fetchEmailMeta(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  uid: number,
  bodyOpts: BodyFetchOpts = {},
): Promise<JmapEmail | null> {
  const msg = await client.fetchOne(`${uid}`, META_QUERY, { uid: true });
  if (!msg) return null;
  return processMessage(client, account, mailbox, msg, bodyOpts);
}

// Bulk variant: a single FETCH for all UIDs in a mailbox, then per-message
// body fetch (each already collapsed to one round trip by fetchBodyValues).
// Returns a Map keyed by uid so callers can match notFound by id.
export async function fetchEmailsBatch(
  client: ImapFlow,
  account: AccountRow,
  mailbox: MailboxRow,
  uids: number[],
  bodyOpts: BodyFetchOpts = {},
): Promise<Map<number, JmapEmail>> {
  const out = new Map<number, JmapEmail>();
  if (uids.length === 0) return out;
  const messages: FetchMessageObject[] = [];
  for await (const m of client.fetch(uids, META_QUERY, { uid: true })) {
    messages.push(m);
  }

  const wantsBodies =
    bodyOpts.fetchTextBodyValues === true ||
    bodyOpts.fetchHTMLBodyValues === true ||
    bodyOpts.fetchAllBodyValues === true;

  // For mail-list views (preview requested, full bodies not requested) we
  // still want to populate `preview`. Group UIDs by their first text/html
  // partId so a single FETCH per group covers the whole page - typical
  // mailboxes collapse to 2-3 round trips total instead of N.
  const previewByUid = new Map<number, string>();
  if (!wantsBodies) {
    interface PreviewTask {
      uid: number;
      partId: string;
      encoding: string | null;
      charset: string | null;
      isHtml: boolean;
    }
    const tasks: PreviewTask[] = [];
    for (const m of messages) {
      if (m.uid == null || !m.bodyStructure) continue;
      const root = structureToBodyParts(m.bodyStructure as never, () => null);
      const sel = selectBodies(root);
      const text = sel.textBody.find((p) => p.partId);
      const html = sel.htmlBody.find((p) => p.partId);
      const part = text ?? html;
      if (!part?.partId) continue;
      tasks.push({
        uid: m.uid,
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
      const groupUids = group.map((t) => t.uid);
      const taskByUid = new Map(group.map((t) => [t.uid, t]));
      try {
        for await (const m of client.fetch(
          groupUids,
          { uid: true, bodyParts: [{ key: partId, start: 0, maxLength: PREVIEW_FETCH_BYTES }] },
          { uid: true },
        )) {
          if (m.uid == null) continue;
          const buf = m.bodyParts?.get(partId);
          if (!buf) continue;
          const t = taskByUid.get(m.uid);
          if (!t) continue;
          const decoded = decodeTransferEncoding(buf, t.encoding);
          const decodedText = decodePartText(decoded, t.charset);
          previewByUid.set(m.uid, buildPreview(decodedText, t.isHtml));
        }
      } catch {
        // best-effort: leave preview empty for this group
      }
    }
  }

  for (const m of messages) {
    if (m.uid == null) continue;
    const preview = previewByUid.get(m.uid);
    out.set(
      m.uid,
      await processMessage(client, account, mailbox, m, bodyOpts, preview),
    );
  }
  return out;
}

function stripBrackets(s: string): string {
  return s.replace(/^<|>$/g, "");
}
