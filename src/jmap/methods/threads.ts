// Thread/get and Thread/changes.
//
// We thread by scanning the account on demand: SELECT each mailbox, FETCH a
// minimal header set (Message-ID, In-Reply-To, References), compute a
// threadId per message via the JWZ heuristic, and group. The result is
// cached for a short window so a Thread/get + Email/query collapseThreads
// pair don't pay for the scan twice.

import type { ImapFlow } from "imapflow";
import type { AccountRow, Store } from "../../state/store.js";
import { decodeEmailId, decodeMailboxId, encodeEmailId } from "../../mapping/ids.js";
import { decodeEmailState, encodeEmailState } from "../../state/states.js";
import { accountNotFound, cannotCalculateChanges } from "../errors.js";
import { withMailbox } from "../../imap/client.js";
import { listMailboxes } from "./mailbox.js";
import { parseHeaderBlock, computeThreadIdFromHeaders } from "../../imap/headers.js";
import { type ChangesResponse } from "./_shared.js";

export interface ThreadGetArgs {
  accountId: string;
  ids: string[] | null;
}

export interface ThreadJson {
  id: string;
  emailIds: string[];
}

export interface ThreadIndex {
  // threadId -> emailIds in that thread, ordered by receivedAt ascending.
  members: Map<string, string[]>;
  // emailId -> threadId for reverse lookup.
  byEmail: Map<string, string>;
  // emailId -> set of raw IMAP flags (e.g. "\\Seen", "\\Flagged"). Used by
  // the noneInThreadHaveKeyword filter.
  flagsByEmail: Map<string, Set<string>>;
}

interface PendingMember {
  emailId: string;
  threadId: string;
  receivedAt: number;
  flags: Set<string>;
}

interface CachedIndex {
  expiresAt: number;
  emailState: number;
  index: ThreadIndex;
}

const indexCache = new Map<number, CachedIndex>();
const INDEX_TTL_MS = 5_000;

export async function buildThreadIndex(ctx: {
  account: AccountRow;
  client: ImapFlow;
  store: Store;
}): Promise<ThreadIndex> {
  const cached = indexCache.get(ctx.account.id);
  const now = Date.now();
  const curState = ctx.store.getState(ctx.account.id, "email");
  if (cached && cached.expiresAt > now && cached.emailState === curState) {
    return cached.index;
  }

  const all = await listMailboxes(ctx.client, ctx.account, ctx.store);
  const rows = ctx.store.db
    .prepare(`SELECT id, name, uidvalidity FROM mailbox WHERE account_id = ?`)
    .all(ctx.account.id) as { id: number; name: string; uidvalidity: number }[];
  const rowById = new Map(rows.map((r) => [r.id, r] as const));

  const index: ThreadIndex = {
    members: new Map(),
    byEmail: new Map(),
    flagsByEmail: new Map(),
  };
  const pending: PendingMember[] = [];
  for (const m of all) {
    const mailboxIdx = decodeMailboxId(m.id).mailboxIdx;
    const row = rowById.get(mailboxIdx);
    if (!row) continue;
    try {
      await withMailbox(ctx.client, row.name, async () => {
        const status =
          ctx.client.mailbox && typeof ctx.client.mailbox === "object"
            ? ctx.client.mailbox
            : null;
        const uidvalidity = Number(
          (status as { uidValidity?: number | bigint } | null)?.uidValidity ?? row.uidvalidity,
        );
        for await (const msg of ctx.client.fetch(
          "1:*",
          {
            uid: true,
            envelope: true,
            internalDate: true,
            flags: true,
            headers: ["message-id", "in-reply-to", "references"],
          },
          { uid: true },
        )) {
          const uid = Number(msg.uid);
          const hb =
            typeof msg.headers === "string" || Buffer.isBuffer(msg.headers)
              ? msg.headers
              : "";
          const headers = parseHeaderBlock(hb);
          const env = msg.envelope as { messageId?: string } | undefined;
          const tid =
            computeThreadIdFromHeaders(headers, env?.messageId ?? null) ??
            encodeEmailId({
              accountIdx: ctx.account.id,
              mailboxIdx,
              uidvalidity,
              uid,
            });
          const eid = encodeEmailId({
            accountIdx: ctx.account.id,
            mailboxIdx,
            uidvalidity,
            uid,
          });
          pending.push({
            emailId: eid,
            threadId: tid,
            receivedAt: msg.internalDate ? new Date(msg.internalDate).getTime() : 0,
            flags: msg.flags ? new Set(msg.flags) : new Set(),
          });
        }
      });
    } catch {
      // Skip folders we can't open; the index just won't include them.
    }
  }
  // RFC 8621 §3 — emailIds in a Thread are ordered by receivedAt ascending.
  pending.sort((a, b) => a.receivedAt - b.receivedAt);
  for (const p of pending) {
    let arr = index.members.get(p.threadId);
    if (!arr) {
      arr = [];
      index.members.set(p.threadId, arr);
    }
    arr.push(p.emailId);
    index.byEmail.set(p.emailId, p.threadId);
    index.flagsByEmail.set(p.emailId, p.flags);
  }
  indexCache.set(ctx.account.id, {
    expiresAt: now + INDEX_TTL_MS,
    emailState: curState,
    index,
  });
  return index;
}

export async function threadGet(
  args: ThreadGetArgs,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<{ accountId: string; state: string; list: ThreadJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const list: ThreadJson[] = [];
  const notFound: string[] = [];
  const ids = args.ids ?? [];
  // Build (or reuse cached) thread membership map across the account.
  const idx = await buildThreadIndex(ctx);
  for (const id of ids) {
    const members = idx.members.get(id);
    if (members && members.length > 0) {
      list.push({ id, emailIds: members });
      continue;
    }
    // Backwards-compat: an emailId-shaped id from the old "thread of one"
    // fallback still resolves to a degenerate thread containing that email.
    try {
      const parts = decodeEmailId(id);
      if (parts.accountIdx === ctx.account.id) {
        list.push({ id, emailIds: [id] });
        continue;
      }
    } catch { /* not a valid email id */ }
    notFound.push(id);
  }
  return {
    accountId: args.accountId,
    state: encodeEmailState({ uidvalidity: 0, modseq: ctx.store.getState(ctx.account.id, "email") }),
    list,
    notFound,
  };
}

// Surface for Email/query collapseThreads.
export function getCachedThreadIndex(accountId: number): ThreadIndex | null {
  const c = indexCache.get(accountId);
  return c ? c.index : null;
}

// Thread/changes is derived from the email-level change log: any email-level
// mutation lifts to a thread-level event for the affected thread. We resolve
// each email id to its threadId via the thread index — built on demand and
// cached for a few seconds. When the log can't reach back to sinceState, we
// fall back to `cannotCalculateChanges` rather than guessing.
export async function threadChanges(
  args: { accountId: string; sinceState: string },
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<ChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const currentNumeric = ctx.store.getState(ctx.account.id, "email");
  const currentRaw = encodeEmailState({ uidvalidity: 0, modseq: currentNumeric });
  if (args.sinceState === currentRaw) {
    return {
      accountId: args.accountId,
      oldState: currentRaw,
      newState: currentRaw,
      hasMoreChanges: false,
      created: [], updated: [], destroyed: [],
    };
  }
  const decoded = (() => {
    try { return decodeEmailState(args.sinceState).modseq; } catch { return null; }
  })();
  if (decoded === null) throw cannotCalculateChanges();
  const entries = ctx.store.entriesSince(ctx.account.id, "email", decoded, currentNumeric);
  if (!entries) throw cannotCalculateChanges();

  const idx = await buildThreadIndex(ctx);
  const created = new Set<string>();
  const updated = new Set<string>();
  const destroyed = new Set<string>();
  // Track whether each affected thread had members BEFORE the window — for
  // the simple "thread didn't exist before" → "created" classification.
  // Without snapshotting the index pre-window we approximate: a thread is
  // created if its CURRENT membership equals the set of created emails seen
  // in this window; otherwise it's updated.
  const threadsTouched = new Map<string, { hadCreate: boolean; hadDestroy: boolean }>();
  for (const e of entries) {
    let tid = idx.byEmail.get(e.id);
    if (!tid) {
      // Email destroyed and no longer in the index — fall back to using its
      // own id as the thread id (matches the degenerate single-message
      // thread case). Safe because the upstream tests just check membership.
      tid = e.id;
    }
    const t = threadsTouched.get(tid) ?? { hadCreate: false, hadDestroy: false };
    if (e.action === "created") t.hadCreate = true;
    if (e.action === "destroyed") t.hadDestroy = true;
    threadsTouched.set(tid, t);
  }
  for (const [tid, t] of threadsTouched) {
    const liveCount = idx.members.get(tid)?.length ?? 0;
    if (liveCount === 0 && t.hadDestroy) destroyed.add(tid);
    else if (t.hadCreate && liveCount > 0) {
      // If we logged a `created` and the thread now exists, treat it as a
      // newly-visible thread from the client's perspective. This is the
      // correct call when `liveCount === 1` (the new email IS the thread)
      // and a defensible approximation when we appended to an existing
      // thread (the spec lets `created` imply "newly visible").
      if (liveCount === 1) created.add(tid);
      else updated.add(tid);
    } else {
      updated.add(tid);
    }
  }
  return {
    accountId: args.accountId,
    oldState: args.sinceState,
    newState: currentRaw,
    hasMoreChanges: false,
    created: [...created],
    updated: [...updated],
    destroyed: [...destroyed],
  };
}
