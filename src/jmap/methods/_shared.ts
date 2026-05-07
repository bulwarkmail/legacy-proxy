// Shared response shapes used by multiple JMAP method handlers.

import { cannotCalculateChanges } from "../errors.js";
import type { Store } from "../../state/store.js";

export interface ChangesResponse {
  accountId: string;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

// `*/changes` for a type whose state we track only as a monotonic counter.
// We can answer two cases honestly: "you're up to date, no changes" and
// "I can't reconstruct the diff." Anything else lies. The router uses this
// for Email, Mailbox, Identity, VacationResponse, AddressBook, ContactCard.
export function changesOrCannotCalculate(
  accountId: string,
  sinceState: string,
  currentState: string,
): ChangesResponse {
  if (sinceState !== currentState) throw cannotCalculateChanges();
  return {
    accountId,
    oldState: currentState,
    newState: currentState,
    hasMoreChanges: false,
    created: [],
    updated: [],
    destroyed: [],
  };
}

// Build a `*/changes` response from the in-memory change log. Falls back to
// `cannotCalculateChanges` whenever the log lost the period the client is
// asking about (eviction, restart, or a sinceState we don't recognise).
//
// Per RFC 8620 §5.2: an id that ends up in `created` MUST NOT also appear in
// `updated`, and an id in `destroyed` overrides any earlier `created`/`updated`.
export function changesFromLog(args: {
  accountId: string;
  store: Store;
  numericAccountId: number;
  kind: string;
  sinceStateRaw: string;
  sinceStateNumeric: number;
  currentStateRaw: string;
  currentStateNumeric: number;
}): ChangesResponse {
  if (args.sinceStateRaw === args.currentStateRaw) {
    return {
      accountId: args.accountId,
      oldState: args.currentStateRaw,
      newState: args.currentStateRaw,
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: [],
    };
  }
  const entries = args.store.entriesSince(
    args.numericAccountId,
    args.kind,
    args.sinceStateNumeric,
    args.currentStateNumeric,
  );
  if (!entries) throw cannotCalculateChanges();

  const created = new Set<string>();
  const updated = new Set<string>();
  const destroyed = new Set<string>();
  for (const e of entries) {
    if (e.action === "created") {
      created.add(e.id);
      updated.delete(e.id);
      destroyed.delete(e.id);
    } else if (e.action === "updated") {
      if (!created.has(e.id) && !destroyed.has(e.id)) updated.add(e.id);
    } else {
      // destroyed
      if (created.has(e.id)) {
        // Created and then destroyed within the window — it never existed
        // from the client's perspective, drop it from both lists.
        created.delete(e.id);
        updated.delete(e.id);
      } else {
        updated.delete(e.id);
        destroyed.add(e.id);
      }
    }
  }
  return {
    accountId: args.accountId,
    oldState: args.sinceStateRaw,
    newState: args.currentStateRaw,
    hasMoreChanges: false,
    created: [...created],
    updated: [...updated],
    destroyed: [...destroyed],
  };
}

export interface QueryChangesResponse {
  accountId: string;
  oldQueryState: string;
  newQueryState: string;
  total?: number;
  removed: string[];
  added: { id: string; index: number }[];
}

// Same shape as above but for `*/queryChanges`. Without persistent indexing of
// query results we cannot compute the diff, so the only safe answer when the
// state has moved is `cannotCalculateChanges`.
export function queryChangesOrCannotCalculate(
  accountId: string,
  sinceQueryState: string,
  currentQueryState: string,
): QueryChangesResponse {
  if (sinceQueryState !== currentQueryState) throw cannotCalculateChanges();
  return {
    accountId,
    oldQueryState: currentQueryState,
    newQueryState: currentQueryState,
    removed: [],
    added: [],
  };
}
