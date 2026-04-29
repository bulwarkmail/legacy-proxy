import type { ImapFlow } from "imapflow";
import type { AccountRow, Store } from "../../state/store.js";
import { decodeEmailId, decodeMailboxId, encodeEmailId } from "../../mapping/ids.js";
import { encodeEmailState } from "../../state/states.js";
import { fetchEmailMeta, type JmapEmail } from "../../imap/fetcher.js";
import { withMailbox } from "../../imap/client.js";
import { accountNotFound, invalidArguments, unsupportedFilter, unsupportedSort } from "../errors.js";
import { compileFilter, UnsupportedFilter, type Filter } from "../../imap/search.js";

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
    const uidvalidity = (status as { uidValidity?: number } | null)?.uidValidity ?? mboxRow.uidvalidity;
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
  args: { accountId: string; ids: string[]; properties?: string[] },
  ctx: { account: AccountRow; client: ImapFlow; store: Store },
): Promise<{ accountId: string; state: string; list: JmapEmail[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const list: JmapEmail[] = [];
  const notFound: string[] = [];
  for (const id of args.ids) {
    const parts = decodeEmailId(id);
    const mboxRow = ctx.store.db
      .prepare(`SELECT * FROM mailbox WHERE id = ? AND account_id = ?`)
      .get(parts.mailboxIdx, ctx.account.id) as
      | { id: number; name: string; uidvalidity: number; highest_modseq: number }
      | undefined;
    if (!mboxRow) {
      notFound.push(id);
      continue;
    }
    const meta = await withMailbox(ctx.client, mboxRow.name, async () =>
      fetchEmailMeta(
        ctx.client,
        ctx.account,
        { ...mboxRow, account_id: ctx.account.id, parent_id: null, delim: "/", role: null, special_use: null, total: 0, unread: 0, subscribed: 0, last_seen: 0 } as never,
        parts.uid,
      ),
    );
    if (meta) list.push(meta);
    else notFound.push(id);
  }
  return {
    accountId: args.accountId,
    state: encodeEmailState({ uidvalidity: 0, modseq: 0 }),
    list,
    notFound,
  };
}
