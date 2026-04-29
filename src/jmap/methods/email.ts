import type { ImapFlow } from "imapflow";
import type { AccountRow, Store } from "../../state/store.js";
import { decodeEmailId, decodeMailboxId, encodeEmailId } from "../../mapping/ids.js";
import { encodeEmailState } from "../../state/states.js";
import { fetchEmailsBatch, type JmapEmail } from "../../imap/fetcher.js";
import { withMailbox } from "../../imap/client.js";
import { JmapError, accountNotFound, invalidArguments, notFound, unsupportedFilter, unsupportedSort } from "../errors.js";
import { compileFilter, UnsupportedFilter, type Filter } from "../../imap/search.js";
import { keywordToFlag } from "../../mapping/flags.js";

export interface EmailQueryArgs {
  accountId: string;
  filter?: Filter;
  sort?: { property: string; isAscending?: boolean }[];
  position?: number;
  limit?: number;
  collapseThreads?: boolean;
}

const SORT_MAP: Record<string, string> = {
  receivedAt: "date",
  from: "from",
  to: "to",
  subject: "subject",
  size: "size",
};

export async function emailQuery(
  args: EmailQueryArgs,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<{
  accountId: string;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  total: number;
  ids: string[];
}> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const filter = args.filter ?? ({} as Filter);
  const inMailbox = "operator" in filter ? null : filter.inMailbox;
  if (!inMailbox) throw invalidArguments("inMailbox is required for v1");

  const m = decodeMailboxId(inMailbox);
  const mboxRow = ctx.store.db
    .prepare(`SELECT * FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(m.mailboxIdx, ctx.account.id) as { name: string; uidvalidity: number } | undefined;
  if (!mboxRow) throw invalidArguments("unknown mailbox");

  let imapFilter;
  try {
    imapFilter = compileFilter(filter);
  } catch (e) {
    if (e instanceof UnsupportedFilter) throw unsupportedFilter(e.message);
    throw e;
  }

  for (const s of args.sort ?? []) {
    if (!SORT_MAP[s.property]) throw unsupportedSort();
  }

  return await withMailbox(ctx.client, mboxRow.name, async () => {
    const status = ctx.client.mailbox && typeof ctx.client.mailbox === "object" ? ctx.client.mailbox : null;
    const uidvalidity = Number(
      (status as { uidValidity?: number | bigint } | null)?.uidValidity ?? mboxRow.uidvalidity,
    );
    const modseq = Number((status as { highestModseq?: bigint } | null)?.highestModseq ?? 0n);

    const uids = (await ctx.client.search(imapFilter, { uid: true })) as number[];
    const sorted = uids.sort((a, b) => b - a);
    const pos = Math.max(0, args.position ?? 0);
    const lim = Math.min(args.limit ?? 50, 500);
    const slice = sorted.slice(pos, pos + lim);
    const ids = slice.map((uid) =>
      encodeEmailId({ accountIdx: ctx.account.id, mailboxIdx: m.mailboxIdx, uidvalidity, uid }),
    );
    return {
      accountId: args.accountId,
      queryState: encodeEmailState({ uidvalidity, modseq }),
      canCalculateChanges: false,
      position: pos,
      total: sorted.length,
      ids,
    };
  });
}

export async function emailGet(
  args: {
    accountId: string;
    ids: string[];
    properties?: string[];
    fetchTextBodyValues?: boolean;
    fetchHTMLBodyValues?: boolean;
    fetchAllBodyValues?: boolean;
    maxBodyValueBytes?: number;
  },
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<{ accountId: string; state: string; list: JmapEmail[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const list: JmapEmail[] = [];
  const notFound: string[] = [];
  const bodyOpts = {
    fetchTextBodyValues: args.fetchTextBodyValues,
    fetchHTMLBodyValues: args.fetchHTMLBodyValues,
    fetchAllBodyValues: args.fetchAllBodyValues,
    maxBodyValueBytes: args.maxBodyValueBytes,
  };

  // Group ids by mailbox so we can do one SELECT + one batched FETCH per
  // mailbox, instead of one per id. UI flows (open thread, open folder)
  // typically request many ids in the same mailbox.
  type Group = { mailboxIdx: number; entries: { id: string; uid: number }[] };
  const groups = new Map<number, Group>();
  for (const id of args.ids) {
    let parts;
    try {
      parts = decodeEmailId(id);
    } catch {
      notFound.push(id);
      continue;
    }
    let g = groups.get(parts.mailboxIdx);
    if (!g) {
      g = { mailboxIdx: parts.mailboxIdx, entries: [] };
      groups.set(parts.mailboxIdx, g);
    }
    g.entries.push({ id, uid: parts.uid });
  }

  for (const group of groups.values()) {
    const mboxRow = ctx.store.db
      .prepare(`SELECT * FROM mailbox WHERE id = ? AND account_id = ?`)
      .get(group.mailboxIdx, ctx.account.id) as
      | { id: number; name: string; uidvalidity: number; highest_modseq: number }
      | undefined;
    if (!mboxRow) {
      for (const e of group.entries) notFound.push(e.id);
      continue;
    }
    const mailboxArg = {
      ...mboxRow,
      account_id: ctx.account.id,
      parent_id: null,
      delim: "/",
      role: null,
      special_use: null,
      total: 0,
      unread: 0,
      subscribed: 0,
      last_seen: 0,
    } as never;
    const uids = group.entries.map((e) => e.uid);
    const fetched = await withMailbox(ctx.client, mboxRow.name, async () =>
      fetchEmailsBatch(ctx.client, ctx.account, mailboxArg, uids, bodyOpts),
    );
    for (const e of group.entries) {
      const meta = fetched.get(e.uid);
      if (meta) list.push(meta);
      else notFound.push(e.id);
    }
  }
  return {
    accountId: args.accountId,
    state: encodeEmailState({ uidvalidity: 0, modseq: 0 }),
    list,
    notFound,
  };
}

// --- Email/set ------------------------------------------------------------

interface MailboxLookup {
  id: number;
  name: string;
  uidvalidity: number;
}

export interface EmailSetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, Record<string, unknown>> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
}

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export interface EmailSetResponse {
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, unknown> | null;
  notCreated: Record<string, SetError> | null;
  updated: Record<string, unknown | null> | null;
  notUpdated: Record<string, SetError> | null;
  destroyed: string[] | null;
  notDestroyed: Record<string, SetError> | null;
}

export async function emailSet(
  args: EmailSetArgs,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<EmailSetResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();

  const oldState = encodeCounterState(ctx.store, ctx.account.id);

  const created: Record<string, unknown> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, unknown | null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};

  // create not implemented (drafts/import live in Email/import + EmailSubmission)
  for (const cid of Object.keys(args.create ?? {})) {
    notCreated[cid] = { type: "forbidden", description: "Email/set create not implemented" };
  }

  for (const [id, patch] of Object.entries(args.update ?? {})) {
    try {
      await applyEmailUpdate(id, patch as Record<string, unknown>, ctx);
      updated[id] = null;
    } catch (e) {
      notUpdated[id] = toSetError(e);
    }
  }

  for (const id of args.destroy ?? []) {
    try {
      await applyEmailDestroy(id, ctx);
      destroyed.push(id);
    } catch (e) {
      notDestroyed[id] = toSetError(e);
    }
  }

  const mutated =
    Object.keys(created).length > 0 ||
    Object.keys(updated).length > 0 ||
    destroyed.length > 0;
  if (mutated) ctx.store.bumpState(ctx.account.id, "email");

  return {
    accountId: args.accountId,
    oldState,
    newState: encodeCounterState(ctx.store, ctx.account.id),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    updated: Object.keys(updated).length ? updated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    destroyed: destroyed.length ? destroyed : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}

function encodeCounterState(store: Store, accountId: number): string {
  // Reuse the same encoder Email/get returns for `state`, so clients can match.
  // We piggyback the email-state counter onto modseq.
  const counter = store.getState(accountId, "email");
  return encodeEmailState({ uidvalidity: 0, modseq: counter });
}

function toSetError(e: unknown): SetError {
  if (e instanceof JmapError) return e.toMethodError() as SetError;
  return { type: "serverFail", description: (e as Error).message };
}

function lookupMailboxByIdx(
  store: Store,
  accountId: number,
  mailboxIdx: number,
): MailboxLookup | null {
  const row = store.db
    .prepare(`SELECT id, name, uidvalidity FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(mailboxIdx, accountId) as MailboxLookup | undefined;
  return row ?? null;
}

function lookupMailboxByEncodedId(
  store: Store,
  accountId: number,
  encodedId: string,
): MailboxLookup {
  let parts;
  try {
    parts = decodeMailboxId(encodedId);
  } catch {
    throw new JmapError("invalidProperties", `unknown mailboxId: ${encodedId}`, {
      properties: ["mailboxIds"],
    });
  }
  if (parts.accountIdx !== accountId) {
    throw new JmapError("invalidProperties", "mailboxId belongs to a different account", {
      properties: ["mailboxIds"],
    });
  }
  const row = lookupMailboxByIdx(store, accountId, parts.mailboxIdx);
  if (!row) {
    throw new JmapError("invalidProperties", `unknown mailboxId: ${encodedId}`, {
      properties: ["mailboxIds"],
    });
  }
  return row;
}

interface ResolvedPatch {
  newMailboxIds: string[] | null; // encoded ids; null = no change
  keywordSet: Record<string, true> | null; // full replacement; null = no change
  keywordAdd: Set<string>;
  keywordRemove: Set<string>;
}

function resolvePatch(patch: Record<string, unknown>): ResolvedPatch {
  const out: ResolvedPatch = {
    newMailboxIds: null,
    keywordSet: null,
    keywordAdd: new Set(),
    keywordRemove: new Set(),
  };
  // Patch entries with paths like "mailboxIds/X" override the full-property
  // entry per RFC 8620 §5.3, but in practice clients send one or the other.
  const mailboxPatch: Record<string, boolean | null> = {};
  let mailboxFull: string[] | null = null;
  for (const [k, v] of Object.entries(patch)) {
    if (k === "mailboxIds") {
      if (v === null || typeof v !== "object") {
        throw invalidArguments("mailboxIds must be an object");
      }
      mailboxFull = Object.keys(v as Record<string, unknown>).filter(
        (id) => (v as Record<string, unknown>)[id] === true,
      );
    } else if (k.startsWith("mailboxIds/")) {
      const id = k.slice("mailboxIds/".length);
      mailboxPatch[id] = v === true ? true : v === null || v === false ? null : true;
    } else if (k === "keywords") {
      if (v === null || typeof v !== "object") {
        throw invalidArguments("keywords must be an object");
      }
      const set: Record<string, true> = {};
      for (const [kw, val] of Object.entries(v as Record<string, unknown>)) {
        if (val === true) set[kw] = true;
      }
      out.keywordSet = set;
    } else if (k.startsWith("keywords/")) {
      const kw = k.slice("keywords/".length);
      if (v === true) out.keywordAdd.add(kw);
      else if (v === null || v === false) out.keywordRemove.add(kw);
    }
    // Other Email properties (subject, from, etc.) cannot be edited in-place
    // on IMAP — silently ignore so the client can still patch flags/folder.
  }

  if (mailboxFull !== null) {
    out.newMailboxIds = mailboxFull;
  } else if (Object.keys(mailboxPatch).length > 0) {
    // We need the current mailbox to apply patch entries; defer until caller
    // has the email's current location. Encode the patch by stashing it.
    out.newMailboxIds = Object.entries(mailboxPatch)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    // Removals: anything explicitly set to null is dropped; in our 1-mailbox
    // model the email is removed from its current box only if the current id
    // appears in the null entries — applyEmailUpdate handles that by checking
    // newMailboxIds against current.
  }

  return out;
}

async function applyEmailUpdate(
  id: string,
  patch: Record<string, unknown>,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<void> {
  const parts = decodeEmailIdSafe(id);
  if (parts.accountIdx !== ctx.account.id) throw notFound();

  const srcMbox = lookupMailboxByIdx(ctx.store, ctx.account.id, parts.mailboxIdx);
  if (!srcMbox) throw notFound();

  const resolved = resolvePatch(patch);

  // Resolve mailbox move target (we only support single-mailbox membership).
  let destMbox: MailboxLookup | null = null;
  if (resolved.newMailboxIds !== null) {
    if (resolved.newMailboxIds.length === 0) {
      // Empty mailboxIds = email removed from all mailboxes ⇒ destroy.
      await applyEmailDestroy(id, ctx);
      return;
    }
    if (resolved.newMailboxIds.length > 1) {
      throw new JmapError(
        "invalidProperties",
        "multi-mailbox membership is not supported by the IMAP backend",
        { properties: ["mailboxIds"] },
      );
    }
    const [first] = resolved.newMailboxIds;
    if (!first) throw invalidArguments("mailboxIds entry missing");
    const target = lookupMailboxByEncodedId(ctx.store, ctx.account.id, first);
    if (target.id !== srcMbox.id) destMbox = target;
  }

  // Apply flag changes in the source mailbox first, then move. After MOVE the
  // UID in the source is gone, so flag operations must precede the move.
  await withMailbox(ctx.client, srcMbox.name, async () => {
    if (resolved.keywordSet !== null) {
      const flags = Object.keys(resolved.keywordSet).map(keywordToFlag);
      await ctx.client.messageFlagsSet(`${parts.uid}`, flags, { uid: true });
    } else {
      if (resolved.keywordAdd.size > 0) {
        const flags = [...resolved.keywordAdd].map(keywordToFlag);
        await ctx.client.messageFlagsAdd(`${parts.uid}`, flags, { uid: true });
      }
      if (resolved.keywordRemove.size > 0) {
        const flags = [...resolved.keywordRemove].map(keywordToFlag);
        await ctx.client.messageFlagsRemove(`${parts.uid}`, flags, { uid: true });
      }
    }
    if (destMbox) {
      const moved = await ctx.client.messageMove(`${parts.uid}`, destMbox.name, { uid: true });
      if (!moved) {
        throw new JmapError("serverFail", `MOVE to "${destMbox.name}" failed`);
      }
    }
  });
}

async function applyEmailDestroy(
  id: string,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<void> {
  const parts = decodeEmailIdSafe(id);
  if (parts.accountIdx !== ctx.account.id) throw notFound();
  const mbox = lookupMailboxByIdx(ctx.store, ctx.account.id, parts.mailboxIdx);
  if (!mbox) throw notFound();
  await withMailbox(ctx.client, mbox.name, async () => {
    await ctx.client.messageDelete(`${parts.uid}`, { uid: true });
  });
}

function decodeEmailIdSafe(id: string): ReturnType<typeof decodeEmailId> {
  try {
    return decodeEmailId(id);
  } catch {
    throw notFound();
  }
}

