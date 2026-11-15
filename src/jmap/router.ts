import { log } from "../util/log.js";
import { JmapError, invalidArguments, unknownMethod } from "./errors.js";
import { harvestCreatedIds, resolveArgs, type CreatedIds } from "./refs.js";
import { describeArgs, describeTrace, newTrace, runTraced } from "./trace.js";

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

/**
 * RFC 8620 §3.3: a Request object has `using` (strings), `methodCalls` (each a
 * [name, arguments object, call id] triple) and optionally `createdIds` (an
 * object). Anything else is answered with the `notRequest` problem.
 */
export function isRequestEnvelope(env: unknown): env is RequestEnvelope {
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  const e = env as Record<string, unknown>;
  if (!Array.isArray(e.using) || !e.using.every((c) => typeof c === "string")) return false;
  if (!Array.isArray(e.methodCalls)) return false;
  const isCall = (c: unknown) =>
    Array.isArray(c) &&
    c.length === 3 &&
    typeof c[0] === "string" &&
    !!c[1] &&
    typeof c[1] === "object" &&
    !Array.isArray(c[1]) &&
    typeof c[2] === "string";
  if (!e.methodCalls.every(isCall)) return false;
  if (e.createdIds !== undefined && (!e.createdIds || typeof e.createdIds !== "object" || Array.isArray(e.createdIds))) {
    return false;
  }
  return true;
}

/** The problem answer for a body that is not a JMAP Request object. */
export const NOT_REQUEST_PROBLEM = {
  type: "urn:ietf:params:jmap:error:notRequest",
  status: 400,
  detail: "The request body is not a valid JMAP Request object",
} as const;

export interface ResponseEnvelope {
  methodResponses: MethodCall[];
  createdIds?: Record<string, string>;
  sessionState: string;
}

/** Handlers are bound by the server; dispatch does not know their transport. */
export type MethodTable = Readonly<Record<string, (args: Record<string, unknown>) => Promise<unknown>>>;

export interface DispatchContext {
  methods: MethodTable;
  maxCallsInRequest: number;
  /** The session's `maxObjectsInGet` and `maxObjectsInSet`, enforced before a method runs. */
  maxObjectsInGet?: number;
  maxObjectsInSet?: number;
  sessionState: string;
}

const countList = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const countMap = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).length : 0);

/**
 * RFC 8620 §5.1 and §5.3: a call that names more objects than the session
 * advertises is answered `requestTooLarge` before its method runs. Counted
 * after result references are resolved. `ids: null` is left to the method.
 */
function checkObjectLimits(name: string, args: Record<string, unknown>, ctx: DispatchContext): void {
  if (ctx.maxObjectsInGet !== undefined) {
    let n = 0;
    if (name === "SearchSnippet/get") n = countList(args.emailIds);
    else if (name.endsWith("/get")) n = countList(args.ids);
    else if (name === "Email/parse") n = countList(args.blobIds);
    if (n > ctx.maxObjectsInGet) {
      throw new JmapError("requestTooLarge", `${n} objects in one ${name}; maxObjectsInGet is ${ctx.maxObjectsInGet}`);
    }
  }
  if (ctx.maxObjectsInSet !== undefined) {
    let n = 0;
    if (name.endsWith("/set")) n = countMap(args.create) + countMap(args.update) + countList(args.destroy);
    else if (name.endsWith("/copy")) n = countMap(args.create);
    else if (name === "Email/import") n = countMap(args.emails);
    if (n > ctx.maxObjectsInSet) {
      throw new JmapError("requestTooLarge", `${n} objects in one ${name}; maxObjectsInSet is ${ctx.maxObjectsInSet}`);
    }
  }
}

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
  "Keyword/get": "https://bulwarkmail.com/ns/jmap/keywords",
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
// Methods that only read. A run of these, none of which references an earlier
// call, can be executed together instead of one after another.
//
// RFC 8620 §3.2 has the server process calls in order, and for anything that
// mutates -- or that reads what a mutation just wrote -- that ordering is
// load-bearing, so those still run alone and act as barriers. For independent
// reads the observable result is identical either way, and the win is real:
// a typical envelope mixes IMAP-backed calls with ones that talk to CardDAV
// over HTTP or ManageSieve over TCP, and serialising them meant every request
// paid the sum of three unrelated transports' latency instead of the maximum.
const PARALLEL_SAFE_METHODS = new Set([
  "Core/echo",
  "Keyword/get",
  "Quota/get",
  "Mailbox/get",
  "Mailbox/query",
  "Mailbox/queryChanges",
  "Mailbox/changes",
  "Email/get",
  "Email/query",
  "Email/changes",
  "Email/queryChanges",
  "Email/parse",
  "SearchSnippet/get",
  "Thread/get",
  "Thread/changes",
  "Identity/get",
  "Identity/changes",
  "EmailSubmission/get",
  "EmailSubmission/query",
  "EmailSubmission/changes",
  "VacationResponse/get",
  "VacationResponse/changes",
  "AddressBook/get",
  "AddressBook/changes",
  "ContactCard/get",
  "ContactCard/query",
  "ContactCard/changes",
  "ContactCard/queryChanges",
  "PushSubscription/get",
]);

// Ceiling on how many calls from one envelope run at once. The interactive
// IMAP pool is the real constraint -- fanning out wider than it just parks
// callers inside the pool -- and it keeps one client from opening a burst of
// work against a shared server.
const MAX_PARALLEL_CALLS = 4;

/**
 * True when a call's arguments carry no dependency on an earlier call in the
 * same request: no top-level `#` result reference (RFC 8620 §3.7) and no
 * `#name` creation reference (§5.3) anywhere inside.
 *
 * Deliberately conservative -- a literal string that merely starts with "#"
 * is treated as a reference. Being wrong that way costs a little parallelism;
 * being wrong the other way would reorder a dependency.
 */
export function hasCrossCallReference(args: unknown): boolean {
  if (typeof args === "string") return args.length > 1 && args.startsWith("#");
  if (args == null || typeof args !== "object") return false;
  if (Array.isArray(args)) return args.some(hasCrossCallReference);
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (k.startsWith("#")) return true;
    if (hasCrossCallReference(v)) return true;
  }
  return false;
}

function isParallelSafe(call: MethodCall): boolean {
  const [name, rawArgs] = call;
  return PARALLEL_SAFE_METHODS.has(name) && !hasCrossCallReference(rawArgs);
}

interface CallOutcome {
  name: string;
  result: unknown;
  sideResponses: MethodCall[] | null;
}

/** Run one method call, turning any throw into its JMAP error response. */
async function runCall(
  call: MethodCall,
  prior: Record<string, { name: string; result: unknown }>,
  createdIds: CreatedIds,
  using: Set<string>,
  ctx: DispatchContext,
): Promise<CallOutcome> {
  const [name, rawArgs, callId] = call;
  const t0 = Date.now();
  const trace = newTrace();
  let shape: Record<string, unknown> | undefined;
  try {
    const args = resolveArgs(rawArgs, prior, createdIds) as Record<string, unknown>;
    shape = describeArgs(args);
    const handler = Object.hasOwn(ctx.methods, name) ? ctx.methods[name] : undefined;
    if (!handler) throw unknownMethod(name);
    const requiredCap = METHOD_CAPABILITY[name];
    if (requiredCap && !using.has(requiredCap)) {
      // The capability gate is treated as unknownMethod per RFC 8620 §3.6.1,
      // not invalidArguments, because the method "doesn't exist" relative
      // to the negotiated capability set.
      throw unknownMethod(name);
    }
    checkObjectLimits(name, args, ctx);
    const result = await runTraced(trace, () => handler(args));
    const ms = Date.now() - t0;
    // What was asked and where the time went, so a slow call names its cause.
    if (ms >= 250)
      log.info(
        { method: name, callId, ms, args: shape, upstream: describeTrace(trace) },
        "jmap method slow",
      );

    // RFC 8621 §7.3: EmailSubmission/set's `onSuccessUpdateEmail` /
    // `onSuccessDestroyEmail` produce an implicit Email/set response alongside
    // the primary one. Handlers attach those via a Symbol-keyed side channel
    // so we don't pollute the on-the-wire result shape.
    const side = (result as { [SIDE_RESPONSES]?: MethodCall[] } | null)?.[SIDE_RESPONSES];
    if (side && Array.isArray(side) && side.length > 0) {
      delete (result as { [SIDE_RESPONSES]?: unknown })[SIDE_RESPONSES];
      return { name, result, sideResponses: side };
    }
    return { name, result, sideResponses: null };
  } catch (e) {
    const ms = Date.now() - t0;
    log.warn(
      { method: name, callId, ms, err: (e as Error).message, args: shape, upstream: describeTrace(trace) },
      "jmap method error",
    );
    const result =
      e instanceof JmapError
        ? e.toMethodError()
        : { type: "serverFail", description: (e as Error).message };
    return { name: "error", result, sideResponses: null };
  }
}

export async function dispatch(env: RequestEnvelope, ctx: DispatchContext): Promise<ResponseEnvelope> {
  if (!isRequestEnvelope(env)) throw new JmapError("notRequest", NOT_REQUEST_PROBLEM.detail);
  if (env.methodCalls.length > ctx.maxCallsInRequest) {
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

  const record = (call: MethodCall, outcome: CallOutcome): void => {
    const callId = call[2];
    harvestCreatedIds(createdIds, outcome.name, outcome.result);
    responses.push([outcome.name, outcome.result as Record<string, unknown>, callId]);
    prior[callId] = { name: outcome.name, result: outcome.result };
    for (const side of outcome.sideResponses ?? []) {
      // Fill in the parent's call id when the handler left a placeholder.
      responses.push([side[0], side[1], side[2] || callId]);
    }
  };

  const calls = env.methodCalls;
  let i = 0;
  while (i < calls.length) {
    // A run of independent reads goes out together; anything else runs alone
    // and, by running alone, acts as a barrier for what follows.
    let end = i;
    while (
      end < calls.length &&
      end - i < MAX_PARALLEL_CALLS &&
      isParallelSafe(calls[end]!)
    ) {
      end++;
    }

    if (end - i > 1) {
      const group = calls.slice(i, end);
      const outcomes = await Promise.all(
        group.map((call) => runCall(call, prior, createdIds, using, ctx)),
      );
      // Responses are appended in the client's original order regardless of
      // which call finished first.
      for (let k = 0; k < group.length; k++) record(group[k]!, outcomes[k]!);
      i = end;
      continue;
    }

    const call = calls[i]!;
    record(call, await runCall(call, prior, createdIds, using, ctx));
    i++;
  }

  const createdIdsOut: Record<string, string> = {};
  for (const [k, v] of createdIds) createdIdsOut[k] = v;

  return {
    methodResponses: responses,
    createdIds: Object.keys(createdIdsOut).length ? createdIdsOut : undefined,
    sessionState: ctx.sessionState,
  };
}
