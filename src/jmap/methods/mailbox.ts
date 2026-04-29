import type { ImapFlow } from "imapflow";
import type { AccountRow, Store } from "../../state/store.js";
import { inferRole } from "../../mapping/mailboxRoles.js";
import { encodeMailboxId } from "../../mapping/ids.js";
import { encodeCounterState } from "../../state/states.js";
import { accountNotFound } from "../errors.js";

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

export async function listMailboxes(
  client: ImapFlow,
  account: AccountRow,
  store: Store,
): Promise<MailboxJson[]> {
  const list = await client.list({ statusQuery: { messages: true, unseen: true } });
  const idByPath = new Map<string, number>();

  const upsert = store.db.prepare(
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

  const rows = store.db
    .prepare(`SELECT * FROM mailbox WHERE account_id = ?`)
    .all(account.id) as Array<{
    id: number;
    name: string;
    parent_id: number | null;
    role: string | null;
    total: number;
    unread: number;
    subscribed: number;
  }>;

  return rows.map((r) => ({
    id: encodeMailboxId({ accountIdx: account.id, mailboxIdx: r.id }),
    name: leafName(r.name),
    parentId: r.parent_id ? encodeMailboxId({ accountIdx: account.id, mailboxIdx: r.parent_id }) : null,
    role: r.role,
    sortOrder: 0,
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
}

function leafName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("."));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export async function mailboxGet(
  args: { accountId: string; ids: string[] | null },
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<{ accountId: string; state: string; list: MailboxJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const all = await listMailboxes(ctx.client, ctx.account, ctx.store);
  const list = args.ids ? all.filter((m) => args.ids!.includes(m.id)) : all;
  const notFound = args.ids ? args.ids.filter((id) => !all.some((m) => m.id === id)) : [];
  return {
    accountId: args.accountId,
    state: encodeCounterState(ctx.store.getState(ctx.account.id, "mailbox")),
    list,
    notFound,
  };
}
