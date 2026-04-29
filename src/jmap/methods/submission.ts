import type { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { AccountRow, Store } from "../../state/store.js";
import type { AppConfig } from "../../util/config.js";
import { decodeEmailId } from "../../mapping/ids.js";
import { withMailbox } from "../../imap/client.js";
import { resolveProvider } from "../../auth/providers.js";
import { openCredentials } from "../../auth/credentials.js";
import { submit } from "../../smtp/submit.js";
import { JmapError, accountNotFound, invalidArguments, notFound } from "../errors.js";
import { applyEmailUpdate } from "./email.js";

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
  const mbox = store.db
    .prepare(`SELECT name FROM mailbox WHERE id = ? AND account_id = ?`)
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
): Promise<EmailSubmissionSetResponse> {
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
      created[tempId] = {
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

  // onSuccessUpdateEmail / onSuccessDestroyEmail: apply post-send.
  const skipDestroy = new Set<string>();
  for (const tempId of args.onSuccessDestroyEmail ?? []) {
    const key = tempId.startsWith("#") ? tempId.slice(1) : tempId;
    const ok = successByTempId.get(key);
    if (!ok) continue;
    try {
      await applyEmailUpdate(ok.emailId, { mailboxIds: {} }, ctx);
      skipDestroy.add(ok.emailId);
    } catch {
      // best-effort: don't fail the submission if cleanup fails
    }
  }
  for (const [refKey, patch] of Object.entries(args.onSuccessUpdateEmail ?? {})) {
    const key = refKey.startsWith("#") ? refKey.slice(1) : refKey;
    const ok = successByTempId.get(key);
    if (!ok) continue;
    if (skipDestroy.has(ok.emailId)) continue;
    try {
      await applyEmailUpdate(ok.emailId, patch as Record<string, unknown>, ctx);
    } catch {
      // best-effort
    }
  }

  if (Object.keys(created).length > 0) {
    ctx.store.bumpState(ctx.account.id, "submission");
    ctx.store.bumpState(ctx.account.id, "email");
  }

  return {
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
}

export async function emailSubmissionGet(
  args: { accountId: string; ids?: string[] | null },
  ctx: { account: AccountRow; store: Store },
): Promise<{ accountId: string; state: string; list: SubmissionResult[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  // We don't persist submissions; treat all as notFound. Clients that only
  // call /get to confirm a submission they just created already have the
  // result from the same request via back-reference.
  const requested = args.ids ?? [];
  return {
    accountId: args.accountId,
    state: stateString(ctx.store.getState(ctx.account.id, "submission")),
    list: [],
    notFound: requested,
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
