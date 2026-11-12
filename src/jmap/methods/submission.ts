import { randomUUID } from "node:crypto";
import type { ImapFlow } from "imapflow";
import type { AccountRow, Store } from "../../state/store.js";
import type { AppConfig } from "../../util/config.js";
import { decodeEmailId } from "../../mapping/ids.js";
import { withMailbox } from "../../imap/client.js";
import { resolveProvider } from "../../auth/providers.js";
import { openCredentials } from "../../auth/credentials.js";
import { submit } from "../../smtp/submit.js";
import { headerValues, isPlainAddress, parseAddressList, readHeaderBlock } from "../../mapping/buildMime.js";
import { JmapError, accountNotFound, cannotCalculateChanges, invalidArguments, notFound } from "../errors.js";
import { applyEmailUpdate } from "./email.js";
import { SIDE_RESPONSES, type MethodCall } from "../router.js";
import { encodeEmailState } from "../../state/states.js";
import { log } from "../../util/log.js";

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

interface SubmissionCreate {
  identityId?: string;
  emailId?: string;
  envelope?: {
    mailFrom?: { email?: string; parameters?: Record<string, unknown> | null };
    rcptTo?: { email?: string; parameters?: Record<string, unknown> | null }[];
  } | null;
}

interface SubmissionResult {
  id: string;
  emailId: string;
  identityId: string;
  threadId: string | null;
  envelope: { mailFrom: { email: string }; rcptTo: { email: string }[] };
  sendAt: string;
  undoStatus: "final";
  deliveryStatus: null;
  dsnBlobIds: string[];
  mdnBlobIds: string[];
}

// Per-account ring buffer of recent submissions so EmailSubmission/get can
// answer the common "I just sent something — show it back to me" pattern. We
// don't persist these (no SQLite table); the cache survives only as long as
// the process. Bounded to keep memory tame across long uptimes.
const MAX_PER_ACCOUNT = 256;
const submissionsByAccount = new Map<number, Map<string, SubmissionResult>>();

function rememberSubmission(accountId: number, sub: SubmissionResult): void {
  let bucket = submissionsByAccount.get(accountId);
  if (!bucket) {
    bucket = new Map();
    submissionsByAccount.set(accountId, bucket);
  }
  bucket.set(sub.id, sub);
  if (bucket.size > MAX_PER_ACCOUNT) {
    // Maps preserve insertion order; drop the oldest.
    const firstKey = bucket.keys().next().value;
    if (firstKey != null) bucket.delete(firstKey);
  }
}

function recallSubmission(accountId: number, id: string): SubmissionResult | undefined {
  return submissionsByAccount.get(accountId)?.get(id);
}

export interface EmailSubmissionSetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, SubmissionCreate> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
  onSuccessUpdateEmail?: Record<string, Record<string, unknown>> | null;
  onSuccessDestroyEmail?: string[] | null;
}

export interface EmailSubmissionSetResponse {
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, SubmissionResult> | null;
  notCreated: Record<string, SetError> | null;
  updated: Record<string, unknown | null> | null;
  notUpdated: Record<string, SetError> | null;
  destroyed: string[] | null;
  notDestroyed: Record<string, SetError> | null;
}

async function fetchRfc822(
  client: ImapFlow,
  emailId: string,
  store: Store,
  accountId: number,
): Promise<{ raw: Buffer; mailboxName: string }> {
  let parts;
  try {
    parts = decodeEmailId(emailId);
  } catch {
    throw notFound();
  }
  if (parts.accountIdx !== accountId) throw notFound();
  const mbox = store
    .prep(`SELECT name FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(parts.mailboxIdx, accountId) as { name: string } | undefined;
  if (!mbox) throw notFound();

  const raw = await withMailbox(client, mbox.name, async () => {
    const msg = await client.fetchOne(`${parts.uid}`, { uid: true, source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    return msg.source;
  });
  if (!raw) throw notFound();
  return { raw, mailboxName: mbox.name };
}

// The Message-ID the recipients see. nodemailer's info.messageId is one it
// makes up itself; with a raw message it never reaches the wire.
export function messageIdOf(raw: Buffer): string | null {
  const text = raw.toString("binary");
  const end = text.search(/\r?\n\r?\n/);
  const head = end < 0 ? text : text.slice(0, end);
  const m = /^message-id:[ \t]*([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/im.exec(head);
  return m ? m[1]!.replace(/\s+/g, " ").trim() : null;
}

// RFC 8621 §7.5: the Bcc header must not reach the recipients. Drop every Bcc
// field (with its folded continuation lines) from the header block, read by
// the same reader that derives the envelope, leaving everything else
// byte-for-byte untouched. A message whose header block can't be read is
// refused before this (see emailSubmissionSet) and is returned unchanged.
export function stripBccHeader(raw: Buffer): Buffer {
  const fields = readHeaderBlock(raw);
  const bcc = (fields ?? []).filter((f) => f.name === "bcc");
  if (bcc.length === 0) return raw;
  const kept: Buffer[] = [];
  let pos = 0;
  for (const f of bcc) {
    kept.push(raw.subarray(pos, f.start));
    pos = f.end;
  }
  kept.push(raw.subarray(pos));
  return Buffer.concat(kept);
}

// Gmail keeps one message per Message-ID, and the copy its SMTP server files in
// Sent shares the draft's id, so it lands on the draft instead: one message
// that stays in Drafts, which Gmail will not let an IMAP client move out (#25).
// Sending under a fresh id, as Thunderbird does, gives Gmail a message of its
// own to file in Sent, and the draft can then simply be deleted.
export function withFreshMessageId(raw: Buffer): Buffer {
  const text = raw.toString("binary");
  const m = /\r?\n\r?\n/.exec(text);
  const headerEnd = m ? m.index : text.length;
  const head = text.slice(0, headerEnd);
  const old = /^message-id:[ \t]*([^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/im.exec(head);
  if (!old) return raw;
  const domain = /@([^>\s]+)>?\s*$/.exec(old[1]!)?.[1] ?? "localhost";
  const replaced = `Message-ID: <${randomUUID()}@${domain}>`;
  return Buffer.from(
    head.slice(0, old.index) + replaced + head.slice(old.index + old[0].length) + text.slice(headerEnd),
    "binary",
  );
}

export { headerValues, isPlainAddress, parseAddressList };

function asEmail(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t;
}

function refuseRecipients(invalid: string[]): never {
  throw new JmapError("invalidRecipients", "recipients must be plain email addresses", {
    invalidRecipients: invalid,
  });
}

/** Accept an envelope only when all its addresses are plain. */
function checkedEnvelope(from: string, to: string[]): { from: string; to: string[] } {
  const invalid = to.filter((a) => !isPlainAddress(a));
  if (invalid.length > 0) refuseRecipients(invalid);
  if (!isPlainAddress(from)) {
    throw new JmapError("forbiddenMailFrom", "the sender must be a plain email address");
  }
  return { from, to };
}

async function resolveEnvelope(
  raw: Buffer,
  envelope: SubmissionCreate["envelope"],
): Promise<{ from: string; to: string[] }> {
  if (envelope?.mailFrom?.email && envelope?.rcptTo?.length) {
    return checkedEnvelope(
      String(envelope.mailFrom.email).trim(),
      envelope.rcptTo.map((r) => (typeof r?.email === "string" ? r.email.trim() : "")),
    );
  }
  // Spec §7: if no envelope is given, derive from headers - From for
  // mailFrom, To+Cc+Bcc for rcptTo. Each member of a group is a recipient.
  // The headers are read here, not by a mail library, so every address is
  // taken as the message wrote it whatever library version is installed.
  const entries = (name: string) => headerValues(raw, name).flatMap(parseAddressList);
  const fromEntry = entries("from")[0];
  if (fromEntry && fromEntry.address === null) {
    throw new JmapError("forbiddenMailFrom", "the sender must be a plain email address");
  }
  const fromAddr = fromEntry ? fromEntry.address : asEmail(envelope?.mailFrom?.email);
  const recipients = ["to", "cc", "bcc"].flatMap(entries);
  // An entry that isn't one plain mailbox is refused, named as the message wrote it.
  const invalid = recipients.filter((e) => e.address === null || !isPlainAddress(e.address));
  if (invalid.length > 0) refuseRecipients(invalid.map((e) => e.address ?? e.written));
  const to = recipients.map((e) => e.address!);
  if (!fromAddr) {
    throw new JmapError("invalidEmail", "could not derive envelope From");
  }
  if (to.length === 0) {
    throw new JmapError("noRecipients", "no recipients in envelope or headers");
  }
  return checkedEnvelope(fromAddr, to);
}

export async function emailSubmissionSet(
  args: EmailSubmissionSetArgs,
  ctx: { cfg: AppConfig; account: AccountRow; client: ImapFlow; store: Store },
): Promise<EmailSubmissionSetResponse & { [SIDE_RESPONSES]?: MethodCall[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();

  const provider = resolveProvider(ctx.cfg, ctx.account.kind);
  if (!provider.smtp) {
    throw new JmapError("forbidden", "no SMTP submission configured for this account");
  }
  const creds = await openCredentials(ctx.cfg.vaultKey, ctx.account.vault);

  const oldState = stateString(ctx.store.getState(ctx.account.id, "submission"));
  const gmail = ctx.account.kind === "gmail";

  const created: Record<string, SubmissionResult> = {};
  const notCreated: Record<string, SetError> = {};
  // Track which submission tempIds succeeded so we can apply
  // onSuccessUpdateEmail / onSuccessDestroyEmail keyed by `#tempId`.
  const successByTempId = new Map<string, { emailId: string }>();

  for (const [tempId, payload] of Object.entries(args.create ?? {})) {
    try {
      if (!payload.emailId) throw invalidArguments("emailId is required");
      const { raw } = await fetchRfc822(ctx.client, payload.emailId, ctx.store, ctx.account.id);
      // Whatever envelope is used, the message goes out as stored: a header
      // block that readers could split differently (and so a Bcc that stays
      // in it) is refused.
      if (!readHeaderBlock(raw)) {
        throw new JmapError(
          "invalidEmail",
          "the message's header lines must all end in CRLF, or all in LF, with no other CR and no blank-looking line",
        );
      }
      const env = await resolveEnvelope(raw, payload.envelope ?? null);
      const outgoing = gmail ? withFreshMessageId(stripBccHeader(raw)) : stripBccHeader(raw);
      const result = await submit({
        provider,
        creds,
        envelopeFrom: env.from,
        rcptTo: env.to,
        raw: outgoing,
      });
      // The only record a send leaves on our side. Without it there is no way
      // to tell "never left the proxy" from "delivered, nobody answered".
      // Addresses are personal data, so they are only logged on request.
      const sendLog = {
        emailId: payload.emailId,
        accepted: result.accepted.length,
        rejected: result.rejected.length,
        smtpResponse: result.response,
        messageId: messageIdOf(outgoing),
        ...(process.env.LOG_SUBMISSION_ADDRESSES === "1"
          ? { mailFrom: env.from, rcptTo: env.to, rejectedAddresses: result.rejected }
          : {}),
      };
      if (result.rejected.length > 0) log.warn(sendLog, "submission: SMTP server rejected some recipients");
      else log.info(sendLog, "submission: accepted by SMTP server");
      // Made here, from nothing the client sent: JMAP ids are server-set.
      const id = `s-${randomUUID()}`;
      const sub: SubmissionResult = {
        id,
        emailId: payload.emailId,
        identityId: payload.identityId ?? `i-${ctx.account.id}`,
        threadId: null,
        envelope: {
          mailFrom: { email: env.from },
          rcptTo: env.to.map((email) => ({ email })),
        },
        sendAt: new Date().toISOString(),
        undoStatus: "final",
        deliveryStatus: null,
        dsnBlobIds: [],
        mdnBlobIds: [],
      };
      created[tempId] = sub;
      rememberSubmission(ctx.account.id, sub);
      successByTempId.set(tempId, { emailId: payload.emailId });
    } catch (e) {
      const smtp = e as { response?: string; responseCode?: number; command?: string; code?: string };
      log.warn(
        {
          emailId: payload.emailId,
          err: (e as Error).message,
          smtpResponse: smtp.response,
          smtpResponseCode: smtp.responseCode,
          smtpCommand: smtp.command,
          code: smtp.code,
        },
        "submission failed",
      );
      notCreated[tempId] = toSetError(e);
    }
  }

  // updates / destroys on EmailSubmission objects don't make sense for our
  // synchronous SMTP path - accept and report no-op.
  const notUpdated: Record<string, SetError> = {};
  for (const id of Object.keys(args.update ?? {})) {
    notUpdated[id] = { type: "forbidden", description: "EmailSubmission/set update not supported" };
  }
  const notDestroyed: Record<string, SetError> = {};
  for (const id of args.destroy ?? []) {
    notDestroyed[id] = { type: "notFound" };
  }

  // onSuccessUpdateEmail / onSuccessDestroyEmail: apply post-send. Per
  // RFC 8621 §7.3 the server emits an implicit Email/set response so the
  // client doesn't have to issue a follow-up call. We collect updates here
  // and ride them out as a SIDE_RESPONSES entry.
  const implicitUpdated: Record<string, null> = {};
  const implicitDestroyed: string[] = [];
  const implicitNotUpdated: Record<string, SetError> = {};
  const implicitNotDestroyed: Record<string, SetError> = {};
  const skipDestroy = new Set<string>();
  for (const tempId of args.onSuccessDestroyEmail ?? []) {
    const key = tempId.startsWith("#") ? tempId.slice(1) : tempId;
    const ok = successByTempId.get(key);
    if (!ok) continue;
    try {
      await applyEmailUpdate(ok.emailId, { mailboxIds: {} }, ctx);
      skipDestroy.add(ok.emailId);
      implicitDestroyed.push(ok.emailId);
    } catch (e) {
      implicitNotDestroyed[ok.emailId] = toSetErrorLike(e);
    }
  }
  for (const [refKey, patch] of Object.entries(args.onSuccessUpdateEmail ?? {})) {
    const key = refKey.startsWith("#") ? refKey.slice(1) : refKey;
    const ok = successByTempId.get(key);
    if (!ok) continue;
    if (skipDestroy.has(ok.emailId)) continue;
    // Gmail's SMTP server has already filed the sent copy in Sent (see
    // withFreshMessageId), so the draft goes instead of being filed again.
    if (gmail) {
      try {
        await applyEmailUpdate(ok.emailId, { mailboxIds: {} }, ctx);
        implicitDestroyed.push(ok.emailId);
      } catch (e) {
        implicitNotDestroyed[ok.emailId] = toSetErrorLike(e);
      }
      continue;
    }
    try {
      await applyEmailUpdate(ok.emailId, patch as Record<string, unknown>, ctx);
      implicitUpdated[ok.emailId] = null;
    } catch (e) {
      implicitNotUpdated[ok.emailId] = toSetErrorLike(e);
    }
  }

  if (Object.keys(created).length > 0) {
    ctx.store.bumpState(ctx.account.id, "submission");
    ctx.store.bumpState(ctx.account.id, "email");
    // The onSuccessUpdateEmail / onSuccessDestroyEmail hooks move the draft
    // into Sent or destroy it, both of which shift folder counts. Bump
    // Mailbox too so caches drop the now-wrong unread/total numbers.
    ctx.store.bumpState(ctx.account.id, "mailbox");
  }

  const primary: EmailSubmissionSetResponse & { [SIDE_RESPONSES]?: MethodCall[] } = {
    accountId: args.accountId,
    oldState,
    newState: stateString(ctx.store.getState(ctx.account.id, "submission")),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    updated: null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    destroyed: null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };

  const hasImplicit =
    Object.keys(implicitUpdated).length > 0 ||
    Object.keys(implicitNotUpdated).length > 0 ||
    implicitDestroyed.length > 0 ||
    Object.keys(implicitNotDestroyed).length > 0;
  if (hasImplicit) {
    const emailModseq = ctx.store.getState(ctx.account.id, "email");
    const implicitEmailSet: Record<string, unknown> = {
      accountId: args.accountId,
      oldState: encodeEmailState({ uidvalidity: 0, modseq: Math.max(0, emailModseq - 1) }),
      newState: encodeEmailState({ uidvalidity: 0, modseq: emailModseq }),
      created: null,
      notCreated: null,
      updated: Object.keys(implicitUpdated).length ? implicitUpdated : null,
      notUpdated: Object.keys(implicitNotUpdated).length ? implicitNotUpdated : null,
      destroyed: implicitDestroyed.length ? implicitDestroyed : null,
      notDestroyed: Object.keys(implicitNotDestroyed).length ? implicitNotDestroyed : null,
    };
    // Call id for the side response is filled in by the dispatch loop with
    // the parent EmailSubmission/set's call id (RFC 8621 §7.3); we pass an
    // empty placeholder here that the loop overwrites.
    primary[SIDE_RESPONSES] = [["Email/set", implicitEmailSet, ""] as MethodCall];
  }
  return primary;
}

function toSetErrorLike(e: unknown): SetError {
  if (e instanceof JmapError) return { type: e.type, description: e.message };
  return { type: "serverFail", description: (e as Error).message };
}

export async function emailSubmissionGet(
  args: { accountId: string; ids?: string[] | null },
  ctx: { account: AccountRow; store: Store },
): Promise<{ accountId: string; state: string; list: SubmissionResult[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const list: SubmissionResult[] = [];
  const notFound: string[] = [];
  if (args.ids == null) {
    // null = "return everything we know about." Drain the in-memory cache.
    const bucket = submissionsByAccount.get(ctx.account.id);
    if (bucket) for (const sub of bucket.values()) list.push(sub);
  } else {
    for (const id of args.ids) {
      const sub = recallSubmission(ctx.account.id, id);
      if (sub) list.push(sub);
      else notFound.push(id);
    }
  }
  return {
    accountId: args.accountId,
    state: stateString(ctx.store.getState(ctx.account.id, "submission")),
    list,
    notFound,
  };
}

export async function emailSubmissionQuery(
  args: { accountId: string; position?: number; limit?: number },
  ctx: { account: AccountRow; store: Store },
): Promise<{
  accountId: string;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  total: number;
  ids: string[];
}> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  return {
    accountId: args.accountId,
    queryState: stateString(ctx.store.getState(ctx.account.id, "submission")),
    canCalculateChanges: false,
    position: 0,
    total: 0,
    ids: [],
  };
}

export async function emailSubmissionChanges(
  args: { accountId: string; sinceState: string },
  ctx: { account: AccountRow; store: Store },
): Promise<{
  accountId: string;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const cur = stateString(ctx.store.getState(ctx.account.id, "submission"));
  // We don't persist submissions, so the only `sinceState` we can answer for
  // is the current one (no changes since). Anything else means the client
  // has a stale state from a prior session that we cannot reconstruct;
  // RFC 8620 §5.2 says reply with `cannotCalculateChanges` so the client
  // re-syncs from /query.
  if (args.sinceState !== cur) {
    throw cannotCalculateChanges();
  }
  return {
    accountId: args.accountId,
    oldState: args.sinceState,
    newState: cur,
    hasMoreChanges: false,
    created: [],
    updated: [],
    destroyed: [],
  };
}

function stateString(counter: number): string {
  return `sub-${counter}`;
}

function toSetError(e: unknown): SetError {
  if (e instanceof JmapError) return e.toMethodError() as SetError;
  return { type: "serverFail", description: (e as Error).message };
}
