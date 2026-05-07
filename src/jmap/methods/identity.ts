import type { AccountRow, Store } from "../../state/store.js";
import { encodeCounterState } from "../../state/states.js";
import { JmapError, accountNotFound } from "../errors.js";
import { changesFromLog, changesOrCannotCalculate, type ChangesResponse } from "./_shared.js";
import { decodeCounterState } from "../../state/states.js";

interface IdentityJson {
  id: string;
  name: string;
  email: string;
  replyTo: { name?: string | null; email: string }[] | null;
  bcc: { name?: string | null; email: string }[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

function identityState(store: Store, accountId: number): string {
  return encodeCounterState(store.getState(accountId, "identity"));
}

function singletonId(accountId: number): string {
  return `i-${accountId}`;
}

// IMAP usernames aren't always email addresses (e.g. shared-hosting accounts
// like `m347812_0-foo`). RFC 8621 §6.1 requires Identity.email to be an email
// address, so when the username has no `@` we synthesize one from the IMAP
// host with the leading service prefix stripped. It's not authoritative —
// providers that know better should send the right replyTo override — but
// it produces a structurally valid address.
function deriveIdentityEmail(account: AccountRow): string {
  if (account.username.includes("@")) return account.username;
  const host = account.host || "localhost";
  const domain = host.replace(/^(imap|imaps|mail|smtp|submission|pop|pop3)\./i, "");
  return `${account.username}@${domain}`;
}

function projectIdentity(account: AccountRow, store: Store): IdentityJson {
  const s = store.getIdentitySettings(account.id);
  return {
    id: singletonId(account.id),
    name: s.displayName ?? account.username,
    email: deriveIdentityEmail(account),
    replyTo: s.replyTo,
    bcc: null,
    textSignature: s.textSignature ?? "",
    htmlSignature: s.htmlSignature ?? "",
    // The Identity is a projection of the IMAP credentials; deleting it would
    // mean losing the account.
    mayDelete: false,
  };
}

export async function identityGet(
  args: { accountId: string; ids: string[] | null },
  ctx: { account: AccountRow; store: Store },
): Promise<{ accountId: string; state: string; list: IdentityJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const all = [projectIdentity(ctx.account, ctx.store)];
  const list = args.ids ? all.filter((i) => args.ids!.includes(i.id)) : all;
  const notFound = args.ids ? args.ids.filter((x) => !all.some((i) => i.id === x)) : [];
  return {
    accountId: args.accountId,
    state: identityState(ctx.store, ctx.account.id),
    list,
    notFound,
  };
}

export interface IdentitySetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, Record<string, unknown>> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
}

// Editable: name, replyTo, textSignature, htmlSignature.
// Refused: create (we expose exactly one Identity), destroy (mayDelete:false),
// changes to email (it's the IMAP login).
export async function identitySet(
  args: IdentitySetArgs,
  ctx: { account: AccountRow; store: Store },
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const oldState = identityState(ctx.store, ctx.account.id);
  if (args.ifInState != null && args.ifInState !== oldState) {
    throw new JmapError("stateMismatch", "ifInState does not match current Identity state");
  }
  const id = singletonId(ctx.account.id);
  const notCreated: Record<string, SetError> = {};
  for (const tempId of Object.keys(args.create ?? {})) {
    notCreated[tempId] = {
      type: "forbidden",
      description: "Identity is a singleton derived from the account credentials",
    };
  }
  const notUpdated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  let mutated = false;
  for (const [target, patch] of Object.entries(args.update ?? {})) {
    if (target !== id) {
      notUpdated[target] = { type: "notFound" };
      continue;
    }
    try {
      applyIdentityPatch(ctx, patch);
      updated[target] = null;
      mutated = true;
    } catch (e) {
      notUpdated[target] = toSetError(e);
    }
  }
  const notDestroyed: Record<string, SetError> = {};
  for (const target of args.destroy ?? []) {
    notDestroyed[target] = { type: "forbidden", description: "Identity may not be destroyed" };
  }

  if (mutated) {
    ctx.store.recordChanges(ctx.account.id, "identity", {
      updated: Object.keys(updated),
    });
  }

  return {
    accountId: args.accountId,
    oldState,
    newState: identityState(ctx.store, ctx.account.id),
    created: null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    updated: Object.keys(updated).length ? updated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    destroyed: null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}

function applyIdentityPatch(
  ctx: { account: AccountRow; store: Store },
  patch: Record<string, unknown>,
): void {
  const cur = ctx.store.getIdentitySettings(ctx.account.id);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "name":
        if (v != null && typeof v !== "string") {
          throw new JmapError("invalidProperties", "name must be a string", { properties: [k] });
        }
        next.displayName = (v as string | null) ?? null;
        break;
      case "textSignature":
        if (v != null && typeof v !== "string") {
          throw new JmapError("invalidProperties", "textSignature must be a string", { properties: [k] });
        }
        next.textSignature = (v as string | null) ?? null;
        break;
      case "htmlSignature":
        if (v != null && typeof v !== "string") {
          throw new JmapError("invalidProperties", "htmlSignature must be a string", { properties: [k] });
        }
        next.htmlSignature = (v as string | null) ?? null;
        break;
      case "replyTo":
        if (v == null) {
          next.replyTo = null;
        } else if (Array.isArray(v)) {
          next.replyTo = v.map((entry) => {
            const e = entry as { name?: string | null; email?: unknown };
            if (typeof e.email !== "string") {
              throw new JmapError("invalidProperties", "replyTo[].email is required", {
                properties: [k],
              });
            }
            return { name: e.name ?? null, email: e.email };
          });
        } else {
          throw new JmapError("invalidProperties", "replyTo must be an array or null", {
            properties: [k],
          });
        }
        break;
      case "email":
        // Server-derived; per RFC 8621 §6.1 changes are not allowed.
        if (v !== ctx.account.username) {
          throw new JmapError("invalidProperties", "email is server-controlled", {
            properties: [k],
          });
        }
        break;
      case "id":
      case "mayDelete":
      case "bcc":
        // ids are immutable; bcc and mayDelete are read-only in our model.
        break;
      default:
        throw new JmapError("invalidProperties", `unknown property: ${k}`, { properties: [k] });
    }
  }
  ctx.store.putIdentitySettings(ctx.account.id, next);
}

export async function identityChanges(
  args: { accountId: string; sinceState: string },
  ctx: { account: AccountRow; store: Store },
): Promise<ChangesResponse> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const currentNumeric = ctx.store.getState(ctx.account.id, "identity");
  const currentRaw = identityState(ctx.store, ctx.account.id);
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
    kind: "identity",
    sinceStateRaw: args.sinceState,
    sinceStateNumeric: sinceNumeric,
    currentStateRaw: currentRaw,
    currentStateNumeric: currentNumeric,
  });
}

function toSetError(e: unknown): SetError {
  if (e instanceof JmapError) return e.toMethodError() as SetError;
  return { type: "serverFail", description: (e as Error).message };
}
