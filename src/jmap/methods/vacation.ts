import type { AccountRow } from "../../state/store.js";
import type { ProviderConfig } from "../../util/config.js";
import { accountNotFound, forbidden } from "../errors.js";
import { SieveClient } from "../../sieve/client.js";
import type { Credentials } from "../../auth/credentials.js";
import { readVacation, writeVacation, type VacationProps } from "../../sieve/vacation.js";

export async function vacationGet(
  args: { accountId: string },
  ctx: { account: AccountRow; provider: ProviderConfig; creds: Credentials },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  if (!ctx.provider.sieve) throw forbidden();
  const c = new SieveClient({ ...ctx.provider.sieve, creds: ctx.creds });
  await c.connect();
  try {
    const v = await readVacation(c);
    return {
      accountId: args.accountId,
      state: "1",
      list: [{ id: "singleton", ...v }],
      notFound: [],
    };
  } finally {
    await c.logout();
  }
}

export async function vacationSet(
  args: { accountId: string; update?: Record<string, Partial<VacationProps>> },
  ctx: { account: AccountRow; provider: ProviderConfig; creds: Credentials },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  if (!ctx.provider.sieve) throw forbidden();
  const next = args.update?.singleton ?? {};
  const v: VacationProps = {
    isEnabled: next.isEnabled ?? false,
    fromDate: next.fromDate ?? null,
    toDate: next.toDate ?? null,
    subject: next.subject ?? null,
    textBody: next.textBody ?? null,
    htmlBody: next.htmlBody ?? null,
  };
  const c = new SieveClient({ ...ctx.provider.sieve, creds: ctx.creds });
  await c.connect();
  try {
    await writeVacation(c, v);
    return {
      accountId: args.accountId,
      oldState: "0",
      newState: "1",
      updated: { singleton: null },
    };
  } finally {
    await c.logout();
  }
}
