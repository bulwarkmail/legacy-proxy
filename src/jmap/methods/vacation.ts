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

// Per-account vacation cache. Reading the autoresponder costs a full
// ManageSieve session — TCP + TLS + greeting + AUTHENTICATE + LISTSCRIPTS +
// GETSCRIPT + LOGOUT — and clients re-read it on every settings screen, so
// the round trip dominates the response time.
//
// The singleton is only mutated through vacationSet, which writes through to
// this cache and bumps the `vacation` state counter. We therefore key on that
// counter (a mismatch means someone else in this process changed it) and add
// a hard TTL to bound staleness from an out-of-band edit — the same
// state-plus-TTL contract listMailboxes uses. Vacation settings change far
// less often than folder counts, hence the longer window.
interface VacationCacheEntry {
  props: VacationProps;
  state: number;
  refreshedAt: number;
}
const vacationCache = new Map<number, VacationCacheEntry>();
const VACATION_CACHE_TTL_MS = 60_000;

function cachedVacation(store: Store, accountId: number): VacationProps | null {
  const entry = vacationCache.get(accountId);
  if (!entry) return null;
  if (Date.now() - entry.refreshedAt >= VACATION_CACHE_TTL_MS) return null;
  if (entry.state !== store.getState(accountId, "vacation")) return null;
  return entry.props;
}

function rememberVacation(store: Store, accountId: number, props: VacationProps): void {
  vacationCache.set(accountId, {
    props,
    state: store.getState(accountId, "vacation"),
    refreshedAt: Date.now(),
  });
}

export async function vacationGet(
  args: { accountId: string; ids?: string[] | null },
  ctx: { account: AccountRow; provider: ProviderConfig; creds: Credentials; store: Store },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  if (!ctx.provider.sieve) throw forbidden();
  let v = cachedVacation(ctx.store, ctx.account.id);
  if (!v) {
    const c = new SieveClient({ ...ctx.provider.sieve, creds: ctx.creds });
    await c.connect();
    try {
      v = await readVacation(c);
    } finally {
      await c.logout();
    }
    rememberVacation(ctx.store, ctx.account.id, v);
  }
  const all = [{ id: "singleton", ...v }];
  const list = args.ids ? all.filter((i) => args.ids!.includes(i.id)) : all;
  const notFound = args.ids ? args.ids.filter((id) => !all.some((i) => i.id === id)) : [];
  return {
    accountId: args.accountId,
    state: vacationState(ctx.store, ctx.account.id),
    list,
    notFound,
  };
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
    // Write through: we just wrote `v`, so the next read is free. Cache after
    // the bump so the entry carries the new counter.
    rememberVacation(ctx.store, ctx.account.id, v);
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
