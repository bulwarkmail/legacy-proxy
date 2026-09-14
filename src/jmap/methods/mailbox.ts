import type { ImapFlow } from "imapflow";
import type { AccountRow, Store } from "../../state/store.js";
import { inferRole } from "../../mapping/mailboxRoles.js";
import { decodeMailboxId, encodeMailboxId } from "../../mapping/ids.js";
import { decodeCounterState, encodeCounterState } from "../../state/states.js";
import { JmapError, accountNotFound, invalidArguments, notFound } from "../errors.js";
import { changesFromLog } from "./_shared.js";
import {
  changesOrCannotCalculate,
  queryChangesOrCannotCalculate,
  type ChangesResponse,
  type QueryChangesResponse,
} from "./_shared.js";

export interface MailboxJson {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: {
    mayReadItems: boolean;
    mayAddItems: boolean;
    mayRemoveItems: boolean;
    maySetSeen: boolean;
    maySetKeywords: boolean;
    mayCreateChild: boolean;
    mayRename: boolean;
    mayDelete: boolean;
    maySubmit: boolean;
  };
  isSubscribed: boolean;
}

// In-memory mailbox-list cache. The slow part of "click a folder" is the
// IMAP LIST + per-mailbox STATUS, which the client triggers on every JMAP
// envelope (Mailbox/get is conventional before Email/query). We cache the
// projected JSON keyed by account + mailbox-state counter:
//   - mutations bump the `mailbox` state, so the next call misses naturally.
//   - a hard TTL guards against any state drift from outside the proxy
//     (NEW MAIL arriving server-side, another client moving a message).
// Memory cost is tiny (one MailboxJson array per account); reset on logout
// is implicit because `cache` is process-local.
interface ListCacheEntry {
  list: MailboxJson[];
  state: number;
  refreshedAt: number;
}
const listCache = new Map<number, ListCacheEntry>();
const LIST_CACHE_HARD_TTL_MS = 30_000;

export async function listMailboxes(
  client: ImapFlow,
  account: AccountRow,
  store: Store,
  opts: { force?: boolean } = {},
): Promise<MailboxJson[]> {
  if (!opts.force) {
    const cached = listCache.get(account.id);
    if (cached) {
      const fresh = Date.now() - cached.refreshedAt < LIST_CACHE_HARD_TTL_MS;
      const stateMatch = cached.state === store.getState(account.id, "mailbox");
      if (fresh && stateMatch) return cached.list;
    }
  }
  const list = await client.list({ statusQuery: { messages: true, unseen: true } });
  const idByPath = new Map<string, number>();

  const upsert = store.prep(
    `INSERT INTO mailbox(account_id, name, parent_id, delim, role, special_use,
                         uidvalidity, highest_modseq, total, unread, subscribed, last_seen)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(account_id, name) DO UPDATE SET
       delim=excluded.delim, role=excluded.role, special_use=excluded.special_use,
       total=excluded.total, unread=excluded.unread, subscribed=excluded.subscribed,
       last_seen=excluded.last_seen
     RETURNING id`,
  );

  const txn = store.db.transaction((items: typeof list) => {
    for (const it of items) {
      const parentName = it.parentPath ?? null;
      const parentId = parentName ? idByPath.get(parentName) ?? null : null;
      const role = inferRole({ name: it.name, specialUse: it.specialUse ? [it.specialUse] : null });
      const row = upsert.get(
        account.id,
        it.path,
        parentId,
        it.delimiter ?? "/",
        role,
        it.specialUse ?? null,
        0,
        0,
        it.status?.messages ?? 0,
        it.status?.unseen ?? 0,
        it.subscribed ? 1 : 0,
        Date.now(),
      ) as { id: number };
      idByPath.set(it.path, row.id);
    }
  });
  txn(list);

  // Reconcile: drop rows the server no longer reports. The upsert above
  // refreshes existing rows but doesn't delete them, so without this step
  // the DB accumulates ghosts from external deletes (or our own mailboxDelete
  // calls) — and the duplicate-name guard would then reject legitimate
  // recreations of a name.
  const livePaths = new Set(list.map((it) => it.path));
  const stale = store
    .prep(`SELECT id, name FROM mailbox WHERE account_id = ?`)
    .all(account.id) as Array<{ id: number; name: string }>;
  const delMbox = store.prep(`DELETE FROM mailbox WHERE id = ? AND account_id = ?`);
  const delTxn = store.db.transaction((victims: typeof stale) => {
    for (const v of victims) if (!livePaths.has(v.name)) delMbox.run(v.id, account.id);
  });
  delTxn(stale);

  const rows = store
    .prep(`SELECT * FROM mailbox WHERE account_id = ?`)
    .all(account.id) as Array<{
    id: number;
    name: string;
    parent_id: number | null;
    role: string | null;
    total: number;
    unread: number;
    subscribed: number;
  }>;

  const sortOrders = store.getMailboxSortOrders(account.id);
  const projected = rows.map((r) => ({
    id: encodeMailboxId({ accountIdx: account.id, mailboxIdx: r.id }),
    name: leafName(r.name),
    parentId: r.parent_id ? encodeMailboxId({ accountIdx: account.id, mailboxIdx: r.parent_id }) : null,
    role: r.role,
    sortOrder: sortOrders.get(r.id) ?? 0,
    totalEmails: r.total,
    unreadEmails: r.unread,
    totalThreads: r.total,
    unreadThreads: r.unread,
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: r.role == null,
      mayDelete: r.role == null,
      maySubmit: true,
    },
    isSubscribed: r.subscribed === 1,
  }));
  listCache.set(account.id, {
    list: projected,
    state: store.getState(account.id, "mailbox"),
    refreshedAt: Date.now(),
  });
  return projected;
}

// Force the next listMailboxes() call to re-run LIST (used after Mailbox/set).
function invalidateListCache(accountId: number): void {
  listCache.delete(accountId);
}

// Targeted alternative to a full LIST+STATUS sweep: after an Email mutation we
// know exactly which folders changed counts, so STATUS just those, update the
// DB rows, and re-stamp the cached list with the (already bumped) mailbox
// state so the next Mailbox/get is served from memory with fresh counts.
// On any failure the cache entry is dropped — the next Mailbox/get falls back
// to the full refresh.
export async function refreshMailboxCounts(
  client: ImapFlow,
  account: AccountRow,
  store: Store,
  mailboxIdxs: number[],
): Promise<void> {
  const entry = listCache.get(account.id);
  if (mailboxIdxs.length === 0) {
    // We know something mutated but not where; be conservative.
    invalidateListCache(account.id);
    return;
  }
  try {
    const updateCounts = store.prep(
      `UPDATE mailbox SET total = ?, unread = ? WHERE id = ? AND account_id = ?`,
    );
    for (const idx of mailboxIdxs) {
      const row = store
        .prep(`SELECT id, name FROM mailbox WHERE id = ? AND account_id = ?`)
        .get(idx, account.id) as { id: number; name: string } | undefined;
      if (!row) continue;
      const st = await client.status(row.name, { messages: true, unseen: true });
      const total = st.messages ?? 0;
      const unread = st.unseen ?? 0;
      updateCounts.run(total, unread, idx, account.id);
      if (entry) {
        const encId = encodeMailboxId({ accountIdx: account.id, mailboxIdx: idx });
        const mb = entry.list.find((m) => m.id === encId);
        if (mb) {
          mb.totalEmails = total;
          mb.unreadEmails = unread;
          mb.totalThreads = total;
          mb.unreadThreads = unread;
        }
      }
    }
    if (entry) entry.state = store.getState(account.id, "mailbox");
  } catch {
    invalidateListCache(account.id);
  }
}

function leafName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("."));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export async function mailboxGet(
  args: { accountId: string; ids: string[] | null; properties?: string[] | null },
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<{ accountId: string; state: string; list: Partial<MailboxJson>[]; notFound: string[] }> {
  if (typeof args.accountId !== "string") throw invalidArguments("accountId is required");
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  if (args.ids !== null && args.ids !== undefined && !Array.isArray(args.ids)) {
    throw invalidArguments("ids must be an array or null");
  }
  if (args.properties != null && !Array.isArray(args.properties)) {
    throw invalidArguments("properties must be an array or null");
  }
  const all = await listMailboxes(ctx.client, ctx.account, ctx.store);
  const list = args.ids ? all.filter((m) => args.ids!.includes(m.id)) : all;
  const notFound = args.ids ? args.ids.filter((id) => !all.some((m) => m.id === id)) : [];
  // RFC 8620 §5.1: if `properties` is given, return only those properties (id
  // is always returned). null/undefined means all properties.
  const projected = args.properties
    ? list.map((m) => projectProperties(m, args.properties!))
    : list;
  return {
    accountId: args.accountId,
    state: mailboxState(ctx.store, ctx.account.id),
    list: projected,
    notFound,
  };
}

function projectProperties(mb: MailboxJson, props: string[]): Partial<MailboxJson> {
  const out: Record<string, unknown> = { id: mb.id };
  const want = new Set(props);
  for (const k of Object.keys(mb)) {
    if (k === "id" || want.has(k)) out[k] = (mb as unknown as Record<string, unknown>)[k];
  }
  return out as Partial<MailboxJson>;
}

function mailboxState(store: Store, accountId: number): string {
  return encodeCounterState(store.getState(accountId, "mailbox"));
}

// --- Mailbox/query --------------------------------------------------------

export interface MailboxQueryArgs {
  accountId: string;
  filter?: { hasAnyRole?: boolean; isSubscribed?: boolean; parentId?: string | null; role?: string | null };
  sort?: { property: string; isAscending?: boolean }[];
  position?: number;
  limit?: number;
}

// Mailbox/query is cheap: we already cache the full list in SQLite. Filters
// supported are the ones a UI actually uses (hasAnyRole, isSubscribed,
// parentId, role). Sort is best-effort: we order by sortOrder then name.
export async function mailboxQuery(
  args: MailboxQueryArgs,
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
  const all = await listMailboxes(ctx.client, ctx.account, ctx.store);
  let result = all;
  const f = args.filter;
  if (f) {
    if (f.hasAnyRole === true) result = result.filter((m) => m.role !== null);
    else if (f.hasAnyRole === false) result = result.filter((m) => m.role === null);
    if (f.isSubscribed === true) result = result.filter((m) => m.isSubscribed);
    else if (f.isSubscribed === false) result = result.filter((m) => !m.isSubscribed);
    if (f.parentId !== undefined) {
      result = result.filter((m) => (m.parentId ?? null) === (f.parentId ?? null));
    }
    if (f.role !== undefined) result = result.filter((m) => m.role === f.role);
  }
  const sort = args.sort ?? [{ property: "sortOrder" }];
  result = [...result].sort((a, b) => {
    for (const s of sort) {
      const asc = s.isAscending !== false;
      const av = (a as unknown as Record<string, unknown>)[s.property];
      const bv = (b as unknown as Record<string, unknown>)[s.property];
      if (av === bv) continue;
      const cmp = (av as number | string) < (bv as number | string) ? -1 : 1;
      return asc ? cmp : -cmp;
    }
    return 0;
  });
  const position = Math.max(0, args.position ?? 0);
  const limit = args.limit && args.limit > 0 ? args.limit : result.length;
  const slice = result.slice(position, position + limit);
  return {
    accountId: args.accountId,
    queryState: mailboxState(ctx.store, ctx.account.id),
    canCalculateChanges: false,
    position,
    total: result.length,
    ids: slice.map((m) => m.id),
  };
}

export async function mailboxChanges(
  args: { accountId: string; sinceState: string },
  ctx: { account: AccountRow; store: Store },
): Promise<ChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const currentNumeric = ctx.store.getState(ctx.account.id, "mailbox");
  const currentRaw = mailboxState(ctx.store, ctx.account.id);
  let sinceNumeric: number;
  try {
    sinceNumeric = decodeCounterState(args.sinceState);
  } catch {
    return changesOrCannotCalculate(args.accountId, args.sinceState, currentRaw);
  }
  return changesFromLog({
    accountId: args.accountId,
    store: ctx.store,
    numericAccountId: ctx.account.id,
    kind: "mailbox",
    sinceStateRaw: args.sinceState,
    sinceStateNumeric: sinceNumeric,
    currentStateRaw: currentRaw,
    currentStateNumeric: currentNumeric,
  });
}

export async function mailboxQueryChanges(
  args: MailboxQueryArgs & { sinceQueryState: string },
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<QueryChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const currentNumeric = ctx.store.getState(ctx.account.id, "mailbox");
  const currentRaw = mailboxState(ctx.store, ctx.account.id);
  if (args.sinceQueryState === currentRaw) {
    return queryChangesOrCannotCalculate(args.accountId, args.sinceQueryState, currentRaw);
  }
  let sinceNumeric: number;
  try {
    sinceNumeric = decodeCounterState(args.sinceQueryState);
  } catch {
    throw new JmapError("cannotCalculateChanges", "unparseable sinceQueryState");
  }
  const entries = ctx.store.entriesSince(ctx.account.id, "mailbox", sinceNumeric, currentNumeric);
  if (!entries) throw new JmapError("cannotCalculateChanges", "out-of-window");

  const fresh = await mailboxQuery(args, ctx);
  const liveSet = new Set(fresh.ids);
  const removed: string[] = [];
  const added: { id: string; index: number }[] = [];
  const seenRemoved = new Set<string>();
  const seenAdded = new Set<string>();
  for (const e of entries) {
    if (e.action === "destroyed" && !seenRemoved.has(e.id) && !liveSet.has(e.id)) {
      seenRemoved.add(e.id);
      removed.push(e.id);
    } else if (e.action === "created" && liveSet.has(e.id) && !seenAdded.has(e.id)) {
      seenAdded.add(e.id);
      const index = fresh.ids.indexOf(e.id);
      added.push({ id: e.id, index });
    }
  }
  return {
    accountId: args.accountId,
    oldQueryState: args.sinceQueryState,
    newQueryState: currentRaw,
    total: fresh.total,
    removed,
    added,
  };
}


// --- Mailbox/set ----------------------------------------------------------

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export interface MailboxSetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, Record<string, unknown>> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
  onDestroyRemoveEmails?: boolean;
}

export interface MailboxSetResponse {
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, MailboxJson> | null;
  notCreated: Record<string, SetError> | null;
  updated: Record<string, null> | null;
  notUpdated: Record<string, SetError> | null;
  destroyed: string[] | null;
  notDestroyed: Record<string, SetError> | null;
}

export async function mailboxSet(
  args: MailboxSetArgs,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<MailboxSetResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const oldState = mailboxState(ctx.store, ctx.account.id);
  if (args.ifInState != null && args.ifInState !== oldState) {
    throw new JmapError("stateMismatch", "ifInState does not match current Mailbox state");
  }

  // Refresh the local cache so we know the right delimiter and parent paths.
  // Bypass the in-memory list cache: even if the state counter looks fresh,
  // a Mailbox/set request implies the client expects a fresh tree.
  invalidateListCache(ctx.account.id);
  await listMailboxes(ctx.client, ctx.account, ctx.store, { force: true });

  const created: Record<string, MailboxJson> = {};
  const notCreated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  const notUpdated: Record<string, SetError> = {};
  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};

  for (const [cid, payload] of Object.entries(args.create ?? {})) {
    try {
      created[cid] = await applyMailboxCreate(payload, ctx);
    } catch (e) {
      notCreated[cid] = toSetError(e);
    }
  }

  for (const [id, patch] of Object.entries(args.update ?? {})) {
    try {
      await applyMailboxUpdate(id, patch, ctx);
      updated[id] = null;
    } catch (e) {
      notUpdated[id] = toSetError(e);
    }
  }

  for (const id of args.destroy ?? []) {
    try {
      await applyMailboxDestroy(id, args.onDestroyRemoveEmails === true, ctx);
      destroyed.push(id);
    } catch (e) {
      notDestroyed[id] = toSetError(e);
    }
  }

  const mutated =
    Object.keys(created).length > 0 ||
    Object.keys(updated).length > 0 ||
    destroyed.length > 0;
  if (mutated) {
    ctx.store.recordChanges(ctx.account.id, "mailbox", {
      created: Object.values(created).map((m) => m.id),
      updated: Object.keys(updated),
      destroyed: [...destroyed],
    });
  }

  return {
    accountId: args.accountId,
    oldState,
    newState: mailboxState(ctx.store, ctx.account.id),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    updated: Object.keys(updated).length ? updated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    destroyed: destroyed.length ? destroyed : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}

interface MailboxRowLite {
  id: number;
  name: string;
  parent_id: number | null;
  delim: string;
  role: string | null;
  subscribed: number;
}

function lookupMailboxRow(store: Store, accountId: number, mailboxIdx: number): MailboxRowLite | null {
  const row = store
    .prep(`SELECT id, name, parent_id, delim, role, subscribed FROM mailbox WHERE id = ? AND account_id = ?`)
    .get(mailboxIdx, accountId) as MailboxRowLite | undefined;
  return row ?? null;
}

function joinPath(parent: string, leaf: string, delim: string): string {
  if (!parent) return leaf;
  return parent.endsWith(delim) ? parent + leaf : parent + delim + leaf;
}

async function applyMailboxCreate(
  payload: Record<string, unknown>,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<MailboxJson> {
  const name = (payload.name as string | undefined)?.trim();
  if (!name) {
    throw new JmapError("invalidProperties", "name is required", { properties: ["name"] });
  }
  const parentId = payload.parentId as string | null | undefined;
  let delim = "/";
  let parentPath = "";
  if (parentId) {
    const parts = decodeMailboxIdSafe(parentId);
    const parent = lookupMailboxRow(ctx.store, ctx.account.id, parts.mailboxIdx);
    if (!parent) {
      throw new JmapError("invalidProperties", "unknown parentId", { properties: ["parentId"] });
    }
    delim = parent.delim || "/";
    parentPath = parent.name;
  } else {
    // Use any existing mailbox's delimiter as the personal-namespace separator.
    const any = ctx.store
      .prep(`SELECT delim FROM mailbox WHERE account_id = ? LIMIT 1`)
      .get(ctx.account.id) as { delim: string } | undefined;
    if (any?.delim) delim = any.delim;
  }
  const fullPath = joinPath(parentPath, name, delim);

  // RFC 8621 §2.5: reject duplicate (parent, name). The proxy's cache was
  // refreshed at the top of mailboxSet, so a hit here means the name really
  // does exist on the server (no race with an external client).
  const existing = ctx.store
    .prep(`SELECT id FROM mailbox WHERE account_id = ? AND name = ?`)
    .get(ctx.account.id, fullPath) as { id: number } | undefined;
  if (existing) {
    throw new JmapError("alreadyExists", `mailbox "${fullPath}" already exists`, {
      existingId: encodeMailboxId({ accountIdx: ctx.account.id, mailboxIdx: existing.id }),
    });
  }

  try {
    await ctx.client.mailboxCreate(fullPath);
  } catch (e) {
    throw new JmapError("serverFail", `IMAP CREATE "${fullPath}" failed: ${(e as Error).message}`);
  }
  if (payload.isSubscribed !== false) {
    try {
      await ctx.client.mailboxSubscribe(fullPath);
    } catch {
      // SUBSCRIBE failures are non-fatal: the box exists either way.
    }
  }
  // Repopulate the cache so the new row gets an id we can return.
  invalidateListCache(ctx.account.id);
  const all = await listMailboxes(ctx.client, ctx.account, ctx.store, { force: true });
  const newRow = ctx.store
    .prep(`SELECT id FROM mailbox WHERE account_id = ? AND name = ?`)
    .get(ctx.account.id, fullPath) as { id: number } | undefined;
  if (!newRow) {
    throw new JmapError("serverFail", "mailbox created but not visible in LIST");
  }
  // sortOrder is opaque to IMAP, so we persist it on our side as a per-mailbox
  // override; absent override, projection falls back to 0.
  const sortOrderRaw = (payload as Record<string, unknown>).sortOrder;
  if (typeof sortOrderRaw === "number" && Number.isFinite(sortOrderRaw)) {
    ctx.store.putMailboxSortOrder(ctx.account.id, newRow.id, Math.trunc(sortOrderRaw));
  }
  const encoded = encodeMailboxId({ accountIdx: ctx.account.id, mailboxIdx: newRow.id });
  const projected = all.find((m) => m.id === encoded);
  if (!projected) {
    throw new JmapError("serverFail", "mailbox created but not visible in LIST");
  }
  if (typeof sortOrderRaw === "number" && Number.isFinite(sortOrderRaw)) {
    projected.sortOrder = Math.trunc(sortOrderRaw);
  }
  return projected;
}

async function applyMailboxUpdate(
  id: string,
  patch: Record<string, unknown>,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<void> {
  let parts;
  try {
    parts = decodeMailboxId(id);
  } catch {
    throw notFound();
  }
  const row = lookupMailboxRow(ctx.store, ctx.account.id, parts.mailboxIdx);
  if (!row) throw notFound();

  // Subscription change (cheap, do it first so a later RENAME can fail without
  // rolling this back — the alternative would be to track and revert).
  if ("isSubscribed" in patch) {
    const want = patch.isSubscribed === true;
    try {
      if (want) await ctx.client.mailboxSubscribe(row.name);
      else await ctx.client.mailboxUnsubscribe(row.name);
    } catch (e) {
      throw new JmapError("serverFail", `subscribe/unsubscribe failed: ${(e as Error).message}`);
    }
  }

  // Name or parentId change → IMAP RENAME.
  const renameName = "name" in patch ? (patch.name as string | undefined)?.trim() : undefined;
  const renameParent = "parentId" in patch ? (patch.parentId as string | null | undefined) : undefined;
  if (renameName !== undefined || renameParent !== undefined) {
    const delim = row.delim || "/";
    const currentLeaf = leafName(row.name);
    const nextLeaf = renameName ?? currentLeaf;
    let nextParentPath = "";
    if (renameParent !== undefined) {
      if (renameParent) {
        const parentParts = decodeMailboxIdSafe(renameParent);
        const parent = lookupMailboxRow(ctx.store, ctx.account.id, parentParts.mailboxIdx);
        if (!parent) {
          throw new JmapError("invalidProperties", "unknown parentId", { properties: ["parentId"] });
        }
        nextParentPath = parent.name;
      }
    } else {
      // keep current parent
      const slash = Math.max(row.name.lastIndexOf(delim), row.name.lastIndexOf("/"));
      nextParentPath = slash >= 0 ? row.name.slice(0, slash) : "";
    }
    const nextPath = joinPath(nextParentPath, nextLeaf, delim);
    if (nextPath !== row.name) {
      try {
        await ctx.client.mailboxRename(row.name, nextPath);
      } catch (e) {
        throw new JmapError("serverFail", `IMAP RENAME "${row.name}" -> "${nextPath}" failed: ${(e as Error).message}`);
      }
      // Update the cached path/parent in place. listMailboxes' upsert keeps
      // (name, parent_id) on conflict, so without this the next Mailbox/get
      // for our id would still see the old path.
      let nextParentId: number | null = null;
      if (renameParent) {
        const parentParts = decodeMailboxIdSafe(renameParent);
        nextParentId = parentParts.mailboxIdx;
      } else if (renameParent === undefined) {
        nextParentId = row.parent_id;
      }
      ctx.store.updateMailboxPath(ctx.account.id, row.id, nextPath, nextParentId);
      invalidateListCache(ctx.account.id);
      await listMailboxes(ctx.client, ctx.account, ctx.store, { force: true });
    }
  }

  if ("sortOrder" in patch) {
    const v = patch.sortOrder;
    if (typeof v === "number" && Number.isFinite(v)) {
      ctx.store.putMailboxSortOrder(ctx.account.id, row.id, Math.trunc(v));
      invalidateListCache(ctx.account.id);
    }
  }
  // `role` is derived from IMAP \\Special-Use; we silently ignore client-set
  // role so they can patch other properties without us bouncing the request.
}

async function applyMailboxDestroy(
  id: string,
  removeEmails: boolean,
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<void> {
  // RFC 8621 §2.5: a destroy targeting a non-existent mailbox returns the
  // standard `notFound` SetError, regardless of whether the id is structurally
  // bogus or simply unknown.
  let parts;
  try {
    parts = decodeMailboxId(id);
  } catch {
    throw notFound();
  }
  const row = lookupMailboxRow(ctx.store, ctx.account.id, parts.mailboxIdx);
  if (!row) throw notFound();
  // §2.5: refuse if the mailbox has child mailboxes — `onDestroyRemoveEmails`
  // covers messages, not the descendant tree.
  const child = ctx.store
    .prep(`SELECT id FROM mailbox WHERE parent_id = ? LIMIT 1`)
    .get(row.id) as { id: number } | undefined;
  if (child) {
    throw new JmapError("mailboxHasChild", "mailbox has descendant mailboxes");
  }
  if (!removeEmails) {
    // Best-effort emptiness check from the cached counter.
    const cnt = ctx.store
      .prep(`SELECT total FROM mailbox WHERE id = ?`)
      .get(row.id) as { total: number } | undefined;
    if (cnt && cnt.total > 0) {
      throw new JmapError("mailboxHasEmail", "mailbox is not empty");
    }
  }
  try {
    await ctx.client.mailboxDelete(row.name);
  } catch (e) {
    throw new JmapError("serverFail", `IMAP DELETE "${row.name}" failed: ${(e as Error).message}`);
  }
}

function decodeMailboxIdSafe(id: string): ReturnType<typeof decodeMailboxId> {
  try {
    return decodeMailboxId(id);
  } catch {
    throw new JmapError("invalidProperties", `bad mailboxId: ${id}`, { properties: ["id"] });
  }
}

function toSetError(e: unknown): SetError {
  if (e instanceof JmapError) return e.toMethodError() as SetError;
  return { type: "serverFail", description: (e as Error).message };
}
