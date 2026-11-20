import { randomBytes } from "node:crypto";
import type { AccountRow, ExtraIdentity, IdentitySettings, Store } from "../../state/store.js";
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

function projectExtra(e: ExtraIdentity): IdentityJson {
  return {
    id: e.id,
    name: e.displayName ?? "",
    email: e.email,
    replyTo: e.replyTo,
    bcc: null,
    textSignature: e.textSignature ?? "",
    htmlSignature: e.htmlSignature ?? "",
    mayDelete: true,
  };
}

/** The login's identity, then those the user created. */
function allIdentities(account: AccountRow, store: Store): IdentityJson[] {
  return [projectIdentity(account, store), ...store.listExtraIdentities(account.id).map(projectExtra)];
}

export async function identityGet(
  args: { accountId: string; ids: string[] | null },
  ctx: { account: AccountRow; store: Store },
): Promise<{ accountId: string; state: string; list: IdentityJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const all = allIdentities(ctx.account, ctx.store);
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

// Identities one account may create next to the login's. They live in the
// proxy's database, so the number is bounded like uploads are.
export const MAX_EXTRA_IDENTITIES = 100;

// Editable on every identity: name, replyTo, textSignature, htmlSignature.
// email is immutable (RFC 8621 §6). The login's identity can't be destroyed;
// further identities can be created with any single address - whether the
// mail server lets the login send as it is decided when sending
// (EmailSubmission fails with the server's answer).
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
  const extras = new Map(ctx.store.listExtraIdentities(ctx.account.id).map((e) => [e.id, e]));

  const created: Record<string, { id: string; mayDelete: boolean }> = {};
  const notCreated: Record<string, SetError> = {};
  for (const [tempId, props] of Object.entries(args.create ?? {})) {
    try {
      if (extras.size >= MAX_EXTRA_IDENTITIES) {
        throw new JmapError("overQuota", `at most ${MAX_EXTRA_IDENTITIES} identities can be added`);
      }
      const email = props.email;
      if (typeof email !== "string" || !isPlainAddress(email)) {
        throw new JmapError("invalidProperties", "email must be one plain address", { properties: ["email"] });
      }
      const { email: _email, ...rest } = props;
      const settings = patchSettings({ displayName: null, replyTo: null, textSignature: null, htmlSignature: null }, rest, email);
      const newId = `${id}-${randomBytes(6).toString("base64url")}`;
      const extra: ExtraIdentity = { id: newId, email: email.trim(), ...settings };
      ctx.store.putExtraIdentity(ctx.account.id, extra);
      extras.set(newId, extra);
      created[tempId] = { id: newId, mayDelete: true };
    } catch (e) {
      notCreated[tempId] = toSetError(e);
    }
  }

  const notUpdated: Record<string, SetError> = {};
  const updated: Record<string, null> = {};
  for (const [target, patch] of Object.entries(args.update ?? {})) {
    try {
      if (target === id) {
        const next = patchSettings(ctx.store.getIdentitySettings(ctx.account.id), patch, deriveIdentityEmail(ctx.account), ctx.account.username);
        ctx.store.putIdentitySettings(ctx.account.id, next);
      } else {
        const extra = extras.get(target);
        if (!extra) {
          notUpdated[target] = { type: "notFound" };
          continue;
        }
        const next = { ...extra, ...patchSettings(extra, patch, extra.email) };
        ctx.store.putExtraIdentity(ctx.account.id, next);
        extras.set(target, next);
      }
      updated[target] = null;
    } catch (e) {
      notUpdated[target] = toSetError(e);
    }
  }

  const destroyed: string[] = [];
  const notDestroyed: Record<string, SetError> = {};
  for (const target of args.destroy ?? []) {
    if (target === id) {
      notDestroyed[target] = { type: "forbidden", description: "the login's identity may not be destroyed" };
    } else if (ctx.store.deleteExtraIdentity(ctx.account.id, target)) {
      extras.delete(target);
      destroyed.push(target);
    } else {
      notDestroyed[target] = { type: "notFound" };
    }
  }

  ctx.store.recordChanges(ctx.account.id, "identity", {
    created: Object.values(created).map((c) => c.id),
    updated: Object.keys(updated),
    destroyed,
  });

  return {
    accountId: args.accountId,
    oldState,
    newState: identityState(ctx.store, ctx.account.id),
    created: Object.keys(created).length ? created : null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    updated: Object.keys(updated).length ? updated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    destroyed: destroyed.length ? destroyed : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}

// One address, no display name or list: what can go into MAIL FROM.
function isPlainAddress(v: string): boolean {
  return /^[^\s@<>",;:()[\]]+@[^\s@<>",;:()[\]]+$/.test(v.trim());
}

function patchSettings(
  cur: IdentitySettings,
  patch: Record<string, unknown>,
  ...ownEmail: string[]
): IdentitySettings {
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
        // Immutable (RFC 8621 §6); sending it back unchanged is fine.
        if (!ownEmail.includes(String(v))) {
          throw new JmapError("invalidProperties", "email is immutable", { properties: [k] });
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
  return next;
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

// -- ParticipantIdentity (JMAP Calendars) --------------------------------------
//
// The addresses the user organises and answers events as. A client compares
// them with an event's participants to find "me": without them Bulwark can't
// tell which attendee to answer for. The one mail Identity is the one
// participant identity, under the same id and with its display name.

export interface ParticipantIdentityJson {
  id: string;
  name: string;
  calendarAddress: string;
  isDefault: boolean;
}

/**
 * The login's identity first (the default), then one per further scheduling
 * address the calendar server knows for the user - on mailbox.org every alias
 * of the mailbox - so an invitation sent to an alias is still recognised as
 * the user's.
 */
function participantIdentities(account: AccountRow, store: Store, addresses: string[]): ParticipantIdentityJson[] {
  const mail = projectIdentity(account, store);
  const out: ParticipantIdentityJson[] = [{ id: mail.id, name: mail.name, calendarAddress: `mailto:${mail.email}`, isDefault: true }];
  const seen = new Set([mail.email.toLowerCase()]);
  for (const addr of addresses) {
    const key = addr.toLowerCase();
    if (seen.has(key) || !addr.includes("@")) continue;
    seen.add(key);
    out.push({ id: `${mail.id}-${Buffer.from(key, "utf8").toString("base64url")}`, name: mail.name, calendarAddress: `mailto:${addr}`, isDefault: false });
  }
  return out;
}

export function participantIdentityGet(
  args: { accountId: string; ids?: string[] | null },
  ctx: { account: AccountRow; store: Store },
  addresses: string[] = [],
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const all = participantIdentities(ctx.account, ctx.store, addresses);
  const ids = args.ids ?? null;
  return {
    accountId: args.accountId,
    state: identityState(ctx.store, ctx.account.id),
    list: ids ? all.filter((i) => ids.includes(i.id)) : all,
    notFound: ids ? ids.filter((x) => !all.some((i) => i.id === x)) : [],
  };
}

// The identities follow the mail login and the calendar server: the login's
// is the default. Making it the default succeeds without a change; anything
// that would add, change or remove one is refused per object.
export function participantIdentitySet(
  args: {
    accountId: string;
    create?: Record<string, unknown> | null;
    update?: Record<string, unknown> | null;
    destroy?: string[] | null;
    onSuccessSetIsDefault?: string | null;
  },
  ctx: { account: AccountRow; store: Store },
  addresses: string[] = [],
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const id = singletonId(ctx.account.id);
  const known = new Set(participantIdentities(ctx.account, ctx.store, addresses).map((i) => i.id));
  if (args.onSuccessSetIsDefault != null && args.onSuccessSetIsDefault !== id) {
    throw new JmapError(
      "invalidArguments",
      known.has(args.onSuccessSetIsDefault) ? "the default participant identity is the mail login's" : `no participant identity ${args.onSuccessSetIsDefault}`,
    );
  }
  const forbidden = { type: "forbidden", description: "participant identities follow the mail login" };
  const notCreated = Object.fromEntries(Object.keys(args.create ?? {}).map((k) => [k, forbidden]));
  const notUpdated = Object.fromEntries(
    Object.keys(args.update ?? {}).map((k) => [k, known.has(k) ? forbidden : { type: "notFound" }]),
  );
  const notDestroyed = Object.fromEntries(
    (args.destroy ?? []).map((k) => [k, known.has(k) ? forbidden : { type: "notFound" }]),
  );
  const state = identityState(ctx.store, ctx.account.id);
  return {
    accountId: args.accountId,
    oldState: state,
    newState: state,
    created: null,
    updated: null,
    destroyed: null,
    notCreated: Object.keys(notCreated).length ? notCreated : null,
    notUpdated: Object.keys(notUpdated).length ? notUpdated : null,
    notDestroyed: Object.keys(notDestroyed).length ? notDestroyed : null,
  };
}
