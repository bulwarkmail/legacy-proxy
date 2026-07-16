import type { ImapPool } from "../imap/pool.js";
import type { Store, AccountRow } from "../state/store.js";
import type { AppConfig } from "../util/config.js";
import type { PushDispatcher } from "../push/dispatcher.js";
import { log } from "../util/log.js";
import { JmapError, invalidArguments, unknownMethod } from "./errors.js";
import { harvestCreatedIds, resolveArgs, type CreatedIds } from "./refs.js";
import {
  mailboxGet,
  mailboxQuery,
  mailboxQueryChanges,
  mailboxChanges,
  mailboxSet,
} from "./methods/mailbox.js";
import {
  emailGet,
  emailQuery,
  emailSet,
  emailChanges,
  emailQueryChanges,
  emailCopy,
  emailParse,
  emailImport,
  searchSnippetGet,
} from "./methods/email.js";
import { identityGet, identitySet, identityChanges } from "./methods/identity.js";
import {
  emailSubmissionChanges,
  emailSubmissionGet,
  emailSubmissionQuery,
  emailSubmissionSet,
} from "./methods/submission.js";
import { vacationGet, vacationSet, vacationChanges } from "./methods/vacation.js";
import {
  addressBookGet,
  addressBookSet,
  addressBookChanges,
  contactCardGet,
  contactCardQuery,
  contactCardSet,
  contactCardChanges,
  contactCardQueryChanges,
  contactsAvailable,
} from "./methods/contacts.js";
import { threadGet, threadChanges } from "./methods/threads.js";
import { pushSubscriptionGet, pushSubscriptionSet } from "./methods/push.js";
import { resolveProvider } from "../auth/providers.js";
import { openCredentials } from "../auth/credentials.js";

export type MethodCall = [string, Record<string, unknown>, string];

// Symbol-keyed slot a handler can use to ride implicit method responses on
// top of its primary result. The dispatch loop pops these off and emits them
// as additional methodResponses entries (with the same call id).
export const SIDE_RESPONSES = Symbol("sideResponses");

export interface RequestEnvelope {
  using: string[];
  methodCalls: MethodCall[];
  createdIds?: Record<string, string>;
}

export interface ResponseEnvelope {
  methodResponses: MethodCall[];
  createdIds?: Record<string, string>;
  sessionState: string;
}

interface Ctx {
  cfg: AppConfig;
  pool: ImapPool;
  store: Store;
  account: AccountRow;
  dispatcher: PushDispatcher;
}

type Handler = (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;

export function makeMethodTable(): Record<string, Handler> {
  return {
    "Core/echo": async (a) => a,
    // RFC 8620 §6.3: Blob/copy. The proxy doesn't (yet) cross account
    // boundaries — IMAP namespaces don't share — so we surface that limitation
    // as the spec-defined error. Same-account copies are also forbidden by
    // §6.3 and must return invalidArguments.
    "Blob/copy": async (a) => {
      const args = a as { fromAccountId?: string; accountId?: string };
      if (!args.fromAccountId || !args.accountId) {
        throw invalidArguments("fromAccountId and accountId are required");
      }
      if (args.fromAccountId === args.accountId) {
        throw invalidArguments("fromAccountId must differ from accountId");
      }
      throw new JmapError(
        "fromAccountNotFound",
        "cross-account Blob/copy is not supported by the IMAP backend",
      );
    },
    // Stubs for capabilities we don't advertise but the UI may probe anyway.
    // Returning an empty result is more graceful than `unknownMethod`, which
    // some clients treat as a fatal protocol error.
    "Quota/get": async (a) => ({
      accountId: (a as { accountId?: string }).accountId ?? "",
      state: "0",
      list: [],
      notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
    }),
    "AddressBook/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          state: "0",
          list: [],
          notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookGet(a as never, { account: c.account, provider, creds });
    },
    "AddressBook/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookSet(a as never, { account: c.account, provider, creds });
    },
    "AddressBook/changes": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return addressBookChanges(a as never, { account: c.account, provider, creds });
    },
    "ContactCard/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          state: "0",
          list: [],
          notFound: ((a as { ids?: string[] | null }).ids ?? []) as string[],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardGet(a as never, { account: c.account, provider, creds });
    },
    "ContactCard/query": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      if (!contactsAvailable(provider)) {
        return {
          accountId: (a as { accountId?: string }).accountId ?? String(c.account.id),
          queryState: "0",
          canCalculateChanges: false,
          position: 0,
          total: 0,
          ids: [],
        };
      }
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardQuery(a as never, { account: c.account, provider, creds });
    },
    "ContactCard/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardSet(a as never, { account: c.account, provider, creds });
    },
    "ContactCard/changes": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardChanges(a as never, { account: c.account, provider, creds });
    },
    "ContactCard/queryChanges": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return contactCardQueryChanges(a as never, { account: c.account, provider, creds });
    },
    "Mailbox/get": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return mailboxGet(a as never, { account: c.account, client, store: c.store });
    },
    "Mailbox/query": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return mailboxQuery(a as never, { account: c.account, client, store: c.store });
    },
    "Mailbox/queryChanges": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return mailboxQueryChanges(a as never, { account: c.account, client, store: c.store });
    },
    "Mailbox/changes": async (a, c) =>
      mailboxChanges(a as never, { account: c.account, store: c.store }),
    "Mailbox/set": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return mailboxSet(a as never, { account: c.account, client, store: c.store });
    },
    "Email/query": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailQuery(a as never, { account: c.account, client, store: c.store, pool: c.pool });
    },
    "Email/get": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailGet(a as never, { account: c.account, client, store: c.store, pool: c.pool });
    },
    "Email/set": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailSet(a as never, { account: c.account, client, store: c.store, pool: c.pool });
    },
    "Email/changes": async (a, c) =>
      emailChanges(a as never, { account: c.account, store: c.store }),
    "Email/queryChanges": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailQueryChanges(a as never, { account: c.account, client, store: c.store, pool: c.pool });
    },
    "Email/copy": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailCopy(a as never, { account: c.account, client, store: c.store });
    },
    "Email/import": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailImport(a as never, { account: c.account, client, store: c.store });
    },
    "Email/parse": async (a, c) =>
      emailParse(a as never, { account: c.account, store: c.store }),
    "SearchSnippet/get": async (a, c) =>
      searchSnippetGet(a as never, { account: c.account }),
    "Thread/get": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return threadGet(a as never, { account: c.account, client, store: c.store, pool: c.pool });
    },
    "Thread/changes": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return threadChanges(a as never, { account: c.account, client, store: c.store, pool: c.pool });
    },
    "PushSubscription/get": async (a, c) =>
      pushSubscriptionGet(a as never, { account: c.account, store: c.store, dispatcher: c.dispatcher }),
    "PushSubscription/set": async (a, c) =>
      pushSubscriptionSet(a as never, { account: c.account, store: c.store, dispatcher: c.dispatcher }),
    "EmailSubmission/get": async (a, c) =>
      emailSubmissionGet(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/query": async (a, c) =>
      emailSubmissionQuery(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/changes": async (a, c) =>
      emailSubmissionChanges(a as never, { account: c.account, store: c.store }),
    "EmailSubmission/set": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailSubmissionSet(a as never, {
        cfg: c.cfg,
        account: c.account,
        client,
        store: c.store,
      });
    },
    "Identity/get": async (a, c) =>
      identityGet(a as never, { account: c.account, store: c.store }),
    "Identity/set": async (a, c) =>
      identitySet(a as never, { account: c.account, store: c.store }),
    "Identity/changes": async (a, c) =>
      identityChanges(a as never, { account: c.account, store: c.store }),
    "VacationResponse/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return vacationGet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "VacationResponse/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return vacationSet(a as never, { account: c.account, provider, creds, store: c.store });
    },
    "VacationResponse/changes": async (a, c) =>
      vacationChanges(a as never, { account: c.account, store: c.store }),
  };
}

const TABLE = makeMethodTable();

// RFC 8620 §3.6.1: each method requires a specific capability in `using`. If
// the client didn't request it, the server returns `unknownMethod` for that
// call — this is what drives error-empty-using and similar cap-gating tests.
const METHOD_CAPABILITY: Record<string, string> = {
  "Core/echo": "urn:ietf:params:jmap:core",
  "Blob/copy": "urn:ietf:params:jmap:core",
  "Mailbox/get": "urn:ietf:params:jmap:mail",
  "Mailbox/query": "urn:ietf:params:jmap:mail",
  "Mailbox/queryChanges": "urn:ietf:params:jmap:mail",
  "Mailbox/changes": "urn:ietf:params:jmap:mail",
  "Mailbox/set": "urn:ietf:params:jmap:mail",
  "Email/query": "urn:ietf:params:jmap:mail",
  "Email/get": "urn:ietf:params:jmap:mail",
  "Email/set": "urn:ietf:params:jmap:mail",
  "Email/changes": "urn:ietf:params:jmap:mail",
  "Email/queryChanges": "urn:ietf:params:jmap:mail",
  "Email/copy": "urn:ietf:params:jmap:mail",
  "Email/import": "urn:ietf:params:jmap:mail",
  "Email/parse": "urn:ietf:params:jmap:mail",
  "SearchSnippet/get": "urn:ietf:params:jmap:mail",
  "Thread/get": "urn:ietf:params:jmap:mail",
  "Thread/changes": "urn:ietf:params:jmap:mail",
  "Identity/get": "urn:ietf:params:jmap:submission",
  "Identity/set": "urn:ietf:params:jmap:submission",
  "Identity/changes": "urn:ietf:params:jmap:submission",
  "EmailSubmission/get": "urn:ietf:params:jmap:submission",
  "EmailSubmission/query": "urn:ietf:params:jmap:submission",
  "EmailSubmission/changes": "urn:ietf:params:jmap:submission",
  "EmailSubmission/set": "urn:ietf:params:jmap:submission",
  "VacationResponse/get": "urn:ietf:params:jmap:vacationresponse",
  "VacationResponse/set": "urn:ietf:params:jmap:vacationresponse",
  "VacationResponse/changes": "urn:ietf:params:jmap:vacationresponse",
  "PushSubscription/get": "urn:ietf:params:jmap:core",
  "PushSubscription/set": "urn:ietf:params:jmap:core",
};

export async function dispatch(env: RequestEnvelope, ctx: Ctx): Promise<ResponseEnvelope> {
  if (!Array.isArray(env.methodCalls)) throw invalidArguments("methodCalls must be an array");
  if (env.methodCalls.length > ctx.cfg.limits.maxCallsInRequest) {
    throw invalidArguments("too many method calls");
  }
  const using = new Set(env.using ?? []);
  const responses: MethodCall[] = [];
  const prior: Record<string, { name: string; result: unknown }> = {};
  const createdIds: CreatedIds = new Map();
  // Seed with any createdIds the client passed in the request envelope so
  // references can span requests (RFC 8620 §3.3).
  for (const [k, v] of Object.entries(env.createdIds ?? {})) {
    if (typeof v === "string") createdIds.set(k, v);
  }

  for (const call of env.methodCalls) {
    const [name, rawArgs, callId] = call;
    let result: unknown;
    let respName = name;
    const t0 = Date.now();
    try {
      const args = resolveArgs(rawArgs, prior, createdIds) as Record<string, unknown>;
      const handler = TABLE[name];
      if (!handler) throw unknownMethod(name);
      const requiredCap = METHOD_CAPABILITY[name];
      if (requiredCap && !using.has(requiredCap)) {
        // The capability gate is treated as unknownMethod per RFC 8620 §3.6.1,
        // not invalidArguments, because the method "doesn't exist" relative
        // to the negotiated capability set.
        throw unknownMethod(name);
      }
      result = await handler(args, ctx);
      harvestCreatedIds(createdIds, name, result);
      const ms = Date.now() - t0;
      if (ms >= 250) log.info({ method: name, callId, ms }, "jmap method slow");
      // RFC 8621 §7.3: EmailSubmission/set's `onSuccessUpdateEmail` /
      // `onSuccessDestroyEmail` produce an implicit Email/set response
      // alongside the primary one. Handlers attach those via a Symbol-keyed
      // side channel so we don't pollute the on-the-wire result shape.
      const sideResponses = (result as { [SIDE_RESPONSES]?: MethodCall[] } | null)?.[SIDE_RESPONSES];
      if (sideResponses && Array.isArray(sideResponses) && sideResponses.length > 0) {
        delete (result as { [SIDE_RESPONSES]?: unknown })[SIDE_RESPONSES];
        responses.push([name, result as Record<string, unknown>, callId]);
        prior[callId] = { name, result };
        for (const side of sideResponses) {
          // Fill in the parent's call id when the handler left a placeholder.
          const sideCall: MethodCall = [side[0], side[1], side[2] || callId];
          responses.push(sideCall);
        }
        continue;
      }
    } catch (e) {
      const ms = Date.now() - t0;
      log.warn({ method: name, callId, ms, err: (e as Error).message }, "jmap method error");
      respName = "error";
      if (e instanceof JmapError) {
        result = e.toMethodError();
      } else {
        result = { type: "serverFail", description: (e as Error).message };
      }
    }
    responses.push([respName, result as Record<string, unknown>, callId]);
    prior[callId] = { name: respName, result };
  }

  const createdIdsOut: Record<string, string> = {};
  for (const [k, v] of createdIds) createdIdsOut[k] = v;

  return {
    methodResponses: responses,
    createdIds: Object.keys(createdIdsOut).length ? createdIdsOut : undefined,
    sessionState: `s${ctx.account.id}`,
  };
}
