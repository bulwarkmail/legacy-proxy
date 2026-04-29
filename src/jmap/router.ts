import type { ImapPool } from "../imap/pool.js";
import type { Store, AccountRow } from "../state/store.js";
import type { AppConfig } from "../util/config.js";
import { JmapError, invalidArguments, unknownMethod } from "./errors.js";
import { resolveArgs } from "./refs.js";
import { mailboxGet } from "./methods/mailbox.js";
import { emailGet, emailQuery } from "./methods/email.js";
import { identityGet } from "./methods/identity.js";
import { vacationGet, vacationSet } from "./methods/vacation.js";
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

  for (const call of env.methodCalls) {
    const [name, rawArgs, callId] = call;
    let result: unknown;
    let respName = name;
    try {
      const args = resolveArgs(rawArgs, prior) as Record<string, unknown>;
      const handler = TABLE[name];
      if (!handler) throw unknownMethod(name);
      result = await handler(args, ctx);
    } catch (e) {
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

  return {
    methodResponses: responses,
    sessionState: `s${ctx.account.id}`,
  };
}
