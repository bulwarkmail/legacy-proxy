import type { ImapPool } from "../imap/pool.js";
import type { Store, AccountRow } from "../state/store.js";
import type { AppConfig } from "../util/config.js";
import { log } from "../util/log.js";
import { JmapError, invalidArguments, unknownMethod } from "./errors.js";
import { harvestCreatedIds, resolveArgs, type CreatedIds } from "./refs.js";
import { mailboxGet } from "./methods/mailbox.js";
import { emailGet, emailQuery, emailSet } from "./methods/email.js";
import { identityGet } from "./methods/identity.js";
import {
  emailSubmissionChanges,
  emailSubmissionGet,
  emailSubmissionQuery,
  emailSubmissionSet,
} from "./methods/submission.js";
import { vacationGet, vacationSet } from "./methods/vacation.js";
import {
  addressBookGet,
  addressBookSet,
  contactCardGet,
  contactCardQuery,
  contactCardSet,
  contactsAvailable,
} from "./methods/contacts.js";
import { resolveProvider } from "../auth/providers.js";
import { openCredentials } from "../auth/credentials.js";

export type MethodCall = [string, Record<string, unknown>, string];

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
}

type Handler = (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;

export function makeMethodTable(): Record<string, Handler> {
  return {
    "Core/echo": async (a) => a,
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
    "Mailbox/get": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return mailboxGet(a as never, { account: c.account, client, store: c.store });
    },
    "Email/query": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailQuery(a as never, { account: c.account, client, store: c.store });
    },
    "Email/get": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailGet(a as never, { account: c.account, client, store: c.store });
    },
    "Email/set": async (a, c) => {
      const client = await c.pool.getForAccount(c.account);
      return emailSet(a as never, { account: c.account, client, store: c.store });
    },
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
    "Identity/get": async (a, c) => identityGet(a as never, { account: c.account }),
    "VacationResponse/get": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return vacationGet(a as never, { account: c.account, provider, creds });
    },
    "VacationResponse/set": async (a, c) => {
      const provider = resolveProvider(c.cfg, c.account.kind);
      const creds = await openCredentials(c.cfg.vaultKey, c.account.vault);
      return vacationSet(a as never, { account: c.account, provider, creds });
    },
  };
}

const TABLE = makeMethodTable();

export async function dispatch(env: RequestEnvelope, ctx: Ctx): Promise<ResponseEnvelope> {
  if (!Array.isArray(env.methodCalls)) throw invalidArguments("methodCalls must be an array");
  if (env.methodCalls.length > ctx.cfg.limits.maxCallsInRequest) {
    throw invalidArguments("too many method calls");
  }
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
      result = await handler(args, ctx);
      harvestCreatedIds(createdIds, name, result);
      const ms = Date.now() - t0;
      if (ms >= 250) log.info({ method: name, callId, ms }, "jmap method slow");
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
