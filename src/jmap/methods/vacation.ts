import type { AccountRow, Store } from "../../state/store.js";
import type { ProviderConfig } from "../../util/config.js";
import { encodeCounterState } from "../../state/states.js";
import { JmapError, accountNotFound, forbidden } from "../errors.js";
import { SieveClient } from "../../sieve/client.js";
import type { Credentials } from "../../auth/credentials.js";
import { generateScript, readVacation, writeVacation, type VacationProps } from "../../sieve/vacation.js";
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

const PATCHABLE = ["isEnabled", "fromDate", "toDate", "subject", "textBody", "htmlBody"] as const;

/**
 * `cur` with the patch applied (RFC 8620 §5.3): a property the patch does not
 * name keeps its value, and null puts it back to its default.
 */
function patched(cur: VacationProps, patch: Partial<VacationProps>): VacationProps {
  const next: VacationProps = { ...cur };
  for (const key of PATCHABLE) {
    if (!(key in patch)) continue;
    if (key === "isEnabled") next.isEnabled = patch.isEnabled ?? false;
    else next[key] = patch[key] ?? null;
  }
  return next;
}

const BLANK: VacationProps = { isEnabled: false, fromDate: null, toDate: null, subject: null, textBody: null, htmlBody: null };

export async function vacationSet(
  args: { accountId: string; update?: Record<string, Partial<VacationProps>> | null },
  ctx: { account: AccountRow; provider: ProviderConfig; creds: Credentials; store: Store },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  if (!ctx.provider.sieve) throw forbidden();
  const oldState = vacationState(ctx.store, ctx.account.id);
  const patch = args.update?.singleton;
  // There is one VacationResponse, "singleton" (RFC 8621 §8): any other id names nothing.
  const strangers = Object.keys(args.update ?? {}).filter((id) => id !== "singleton");
  const notFound = strangers.length ? Object.fromEntries(strangers.map((id) => [id, { type: "notFound" }])) : null;
  // Nothing asked of the singleton: nothing to write.
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return { accountId: args.accountId, oldState, newState: oldState, updated: null, ...(notFound ? { notUpdated: notFound } : {}) };
  }
  // A value the script can't carry (a date that isn't one, a start after the
  // end) is a SetError for the singleton. What the patch brings is checked on
  // its own first, so a value wrong by itself is found before any ManageSieve
  // session; the patch applied to the stored response is checked again when
  // it is written.
  const refused = (e: unknown) =>
    e instanceof JmapError && e.type === "invalidProperties"
      ? { accountId: args.accountId, oldState, newState: oldState, updated: null, notUpdated: { ...notFound, singleton: e.toMethodError() } }
      : null;
  try {
    generateScript(patched(BLANK, patch));
  } catch (e) {
    const answer = refused(e);
    if (answer) return answer;
    throw e;
  }
  const c = new SieveClient({ ...ctx.provider.sieve, creds: ctx.creds });
  await c.connect();
  try {
    // The stored response is read from the server, not from the cache: what
    // is written back must not be older than what the server holds. A read
    // that fails fails the call, or blanks would be written over the message.
    const complete = PATCHABLE.every((key) => key in patch);
    const v = patched(complete ? BLANK : await readVacation(c, true), patch);
    try {
      await writeVacation(c, v);
    } catch (e) {
      const answer = refused(e);
      if (answer) return answer;
      throw e;
    }
    ctx.store.bumpState(ctx.account.id, "vacation");
    // Write through: we just wrote `v`, so the next read is free. Cache after
    // the bump so the entry carries the new counter.
    rememberVacation(ctx.store, ctx.account.id, v);
    return {
      accountId: args.accountId,
      oldState,
      newState: vacationState(ctx.store, ctx.account.id),
      updated: { singleton: null },
      ...(notFound ? { notUpdated: notFound } : {}),
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
