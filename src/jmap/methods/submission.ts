import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AccountRow, Store } from "../../state/store.js";
import type { AppConfig } from "../../util/config.js";
import { decodeEmailId } from "../../mapping/ids.js";
import { withMailbox } from "../../imap/client.js";
import { resolveProvider } from "../../auth/providers.js";
import { openCredentials } from "../../auth/credentials.js";
import { submit } from "../../smtp/submit.js";
import { JmapError, accountNotFound, cannotCalculateChanges, invalidArguments, notFound } from "../errors.js";
import { applyEmailUpdate } from "./email.js";
import { SIDE_RESPONSES, type MethodCall } from "../router.js";
import { encodeEmailState } from "../../state/states.js";

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

function asEmail(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  return t;
}

async function resolveEnvelope(
  raw: Buffer,
  envelope: SubmissionCreate["envelope"],
): Promise<{ from: string; to: string[] }> {
  if (envelope?.mailFrom?.email && envelope?.rcptTo?.length) {
    return {
      from: envelope.mailFrom.email,
      to: envelope.rcptTo.map((r) => r.email!).filter(Boolean),
    };
  }
  // Spec §7: if no envelope is given, derive from headers - From for
  // mailFrom, To+Cc+Bcc for rcptTo.
  const parsed = await simpleParser(raw);
  const fromAddr =
    asEmail(parsed.from?.value?.[0]?.address) ?? asEmail(envelope?.mailFrom?.email) ?? null;
  const collect = (
    field: { value?: { address?: string }[] } | { value?: { address?: string }[] }[] | undefined,
  ): string[] => {
    if (!field) return [];
    const arr = Array.isArray(field) ? field : [field];
    const out: string[] = [];
    for (const f of arr) {
      for (const v of f.value ?? []) {
        const e = asEmail(v.address);
        if (e) out.push(e);
      }
    }
    return out;
  };
  const to = [...collect(parsed.to), ...collect(parsed.cc), ...collect(parsed.bcc)];
  if (!fromAddr) {
    throw new JmapError("invalidEmail", "could not derive envelope From");
  }
  if (to.length === 0) {
    throw new JmapError("noRecipients", "no recipients in envelope or headers");
  }
  return { from: fromAddr, to };
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

  const created: Record<string, SubmissionResult> = {};
  const notCreated: Record<string, SetError> = {};
  // Track which submission tempIds succeeded so we can apply
  // onSuccessUpdateEmail / onSuccessDestroyEmail keyed by `#tempId`.
  const successByTempId = new Map<string, { emailId: string }>();

  for (const [tempId, payload] of Object.entries(args.create ?? {})) {
    try {
      if (!payload.emailId) throw invalidArguments("emailId is required");
      const { raw } = await fetchRfc822(ctx.client, payload.emailId, ctx.store, ctx.account.id);
      const env = await resolveEnvelope(raw, payload.envelope ?? null);
      await submit({
        provider,
        creds,
        envelopeFrom: env.from,
        rcptTo: env.to,
        raw,
      });
      const id = `s-${ctx.account.id}-${Date.now()}-${tempId}`;
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
