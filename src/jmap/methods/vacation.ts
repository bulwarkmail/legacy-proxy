import type { AccountRow, Store } from "../../state/store.js";
import type { ProviderConfig } from "../../util/config.js";
import { encodeCounterState } from "../../state/states.js";
import { accountNotFound, forbidden } from "../errors.js";
import { SieveClient } from "../../sieve/client.js";
import type { Credentials } from "../../auth/credentials.js";
import { readVacation, writeVacation, type VacationProps } from "../../sieve/vacation.js";
import { changesOrCannotCalculate, type ChangesResponse } from "./_shared.js";

function vacationState(store: Store, accountId: number): string {
  return encodeCounterState(store.getState(accountId, "vacation"));
}

export async function vacationGet(
  args: { accountId: string; ids?: string[] | null },
  ctx: { account: AccountRow; provider: ProviderConfig; creds: Credentials; store: Store },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  if (!ctx.provider.sieve) throw forbidden();
  const c = new SieveClient({ ...ctx.provider.sieve, creds: ctx.creds });
  await c.connect();
  try {
    const v = await readVacation(c);
    const all = [{ id: "singleton", ...v }];
    const list = args.ids ? all.filter((i) => args.ids!.includes(i.id)) : all;
    const notFound = args.ids ? args.ids.filter((id) => !all.some((i) => i.id === id)) : [];
    return {
      accountId: args.accountId,
      state: vacationState(ctx.store, ctx.account.id),
      list,
      notFound,
    };
  } finally {
    await c.logout();
  }
}

export async function vacationSet(
  args: { accountId: string; update?: Record<string, Partial<VacationProps>> },
  ctx: { account: AccountRow; provider: ProviderConfig; creds: Credentials; store: Store },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  if (!ctx.provider.sieve) throw forbidden();
  const oldState = vacationState(ctx.store, ctx.account.id);
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
    ctx.store.bumpState(ctx.account.id, "vacation");
    return {
      accountId: args.accountId,
      oldState,
      newState: vacationState(ctx.store, ctx.account.id),
      updated: { singleton: null },
    };
  } finally {
    await c.logout();
  }
}

export async function vacationChanges(
  args: { accountId: string; sinceState: string },
  ctx: { account: AccountRow; store: Store },
): Promise<ChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  return changesOrCannotCalculate(args.accountId, args.sinceState, vacationState(ctx.store, ctx.account.id));
}
