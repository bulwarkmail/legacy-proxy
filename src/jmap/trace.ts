import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Where one method call spent its time, for the slow-call log.
 *
 * "Slow" alone does not say what to fix: thirty seconds of waiting for a quota
 * slot, of Google answering, and of reading the local cache look the same from
 * outside. The backend adds to the trace of whichever call it is working for;
 * the dispatcher prints it next to the call's arguments.
 *
 * Work that several calls share (two requests waiting on the same upstream
 * read) is booked to the call that started it; the others show the wait as
 * time with no upstream work of their own.
 */
export interface CallTrace {
  /** Upstream requests sent (a batch counts once, a retry counts again). */
  calls: number;
  /** Reads carried by those requests (a batch of 50 counts 50). */
  reads: number;
  /** Provider quota units spent. */
  units: number;
  /** Reads the provider turned away for rate limiting. */
  refused: number;
  /** Time spent queued for a slot, paced, or backing off. */
  waitMs: number;
  /** Time the provider took to answer. */
  netMs: number;
  /** Time spent in the local cache (decrypting, writing). */
  cacheMs: number;
}

const storage = new AsyncLocalStorage<CallTrace>();

export const newTrace = (): CallTrace => ({
  calls: 0,
  reads: 0,
  units: 0,
  refused: 0,
  waitMs: 0,
  netMs: 0,
  cacheMs: 0,
});
export const runTraced = <T>(trace: CallTrace, work: () => Promise<T>): Promise<T> =>
  storage.run(trace, work);
export const currentTrace = (): CallTrace | undefined => storage.getStore();

/**
 * Filter keys whose values say what kind of query this is and nothing about
 * the user: mailboxes, keywords, dates, sizes, flags. Every other key - search
 * text, addresses, a contact's uid, whatever a method this proxy does not even
 * serve was sent - is logged as the kind and length of its value only. A list
 * of what is safe, not of what is not: a key nobody thought of stays out.
 */
const SHOWN_KEYS = new Set([
  "operator",
  "inMailbox",
  "inMailboxOtherThan",
  "hasKeyword",
  "notKeyword",
  "allInThreadHaveKeyword",
  "someInThreadHaveKeyword",
  "noneInThreadHaveKeyword",
  "before",
  "after",
  "minSize",
  "maxSize",
  "hasAttachment",
  "role",
  "hasAnyRole",
  "isSubscribed",
  "parentId",
  // Sort comparators.
  "property",
  "isAscending",
  "keyword",
]);

const hidden = (value: unknown): string =>
  `<${Array.isArray(value) ? "array" : value === null ? "null" : typeof value} ${JSON.stringify(value)?.length ?? 0}>`;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(value))
    return value.length > 8
      ? [...value.slice(0, 8).map((v) => redact(v, depth + 1)), `…+${value.length - 8}`]
      : value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        key === "conditions"
          ? redact(v, depth + 1)
          : !SHOWN_KEYS.has(key)
            ? hidden(v)
            : typeof v === "object" && v !== null
              ? // A shown key holds ids or flags, never an object to walk into.
                Array.isArray(v) && v.every((x) => typeof x === "string")
                ? v.length > 8
                  ? [...v.slice(0, 8), `…+${v.length - 8}`]
                  : v
                : hidden(v)
              : typeof v === "string" && v.length > 80
                ? v.slice(0, 80) + "…"
                : v,
      ]),
    );
  // A bare value where a condition was expected.
  return hidden(value);
}

/**
 * The shape of a call's arguments, for the log: which filter, sort and window,
 * and how much was asked for - never the search text, an address or an id list.
 */
export function describeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["filter", "sort"])
    if (args[key] != null) out[key] = redact(args[key]);
  for (const key of [
    "limit",
    "position",
    "anchorOffset",
    "collapseThreads",
    "calculateTotal",
    "fetchTextBodyValues",
    "fetchHTMLBodyValues",
    "fetchAllBodyValues",
    "sinceState",
    "maxChanges",
  ])
    if (args[key] != null) out[key] = args[key];
  if (args.anchor != null) out.anchor = true;
  if (Array.isArray(args.ids)) out.ids = args.ids.length;
  else if ("ids" in args) out.ids = null;
  if (Array.isArray(args.properties))
    out.properties = args.properties.length > 24 ? args.properties.length : args.properties;
  for (const key of ["create", "update", "destroy"]) {
    const v = args[key];
    if (Array.isArray(v)) out[key] = v.length;
    else if (v && typeof v === "object") out[key] = Object.keys(v).length;
  }
  return out;
}

/** The trace as logged: rounded, and absent when the call touched nothing. */
export function describeTrace(trace: CallTrace): Record<string, number> | undefined {
  if (!trace.calls && trace.waitMs < 1 && trace.cacheMs < 1) return undefined;
  return {
    calls: trace.calls,
    reads: trace.reads,
    units: trace.units,
    ...(trace.refused ? { refused: trace.refused } : {}),
    waitMs: Math.round(trace.waitMs),
    netMs: Math.round(trace.netMs),
    cacheMs: Math.round(trace.cacheMs),
  };
}
