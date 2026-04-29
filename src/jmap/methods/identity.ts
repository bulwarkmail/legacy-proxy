import type { AccountRow } from "../../state/store.js";
import { accountNotFound } from "../errors.js";

export async function identityGet(
  args: { accountId: string; ids: string[] | null },
  ctx: { account: AccountRow },
): Promise<{ accountId: string; state: string; list: unknown[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const id = `i-${ctx.account.id}`;
  const all = [
    {
      id,
      name: ctx.account.username,
      email: ctx.account.username,
      replyTo: null,
      bcc: null,
      textSignature: null,
      htmlSignature: null,
      mayDelete: false,
    },
  ];
  const list = args.ids ? all.filter((i) => args.ids!.includes(i.id)) : all;
  const notFound = args.ids ? args.ids.filter((x) => !all.some((i) => i.id === x)) : [];
  return { accountId: args.accountId, state: "1", list, notFound };
}
