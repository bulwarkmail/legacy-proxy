// Resolve back-references in a method call's arguments per RFC 8620.
//
// Two distinct cross-call mechanisms:
//
// §3.7 - Result references: an arg key prefixed with `#` whose value is
//   `{ resultOf, name, path }` is replaced by walking that JSON pointer
//   into the previous response. Only valid at the top level of the args
//   object - nested `#`-prefixed keys (e.g. EmailSubmission/set's
//   `onSuccessUpdateEmail: { "#tempId": patch }`) are creation-reference
//   keys per RFC 8621 §7.3 and must pass through unchanged.
//
// §5.3 - Creation references: any string value that looks like `#name`
//   refers to the createdId returned by a previous `*/set` call in the
//   same request. The server replaces it with the actual server-assigned
//   id.

import { JmapError } from "./errors.js";

export interface ResultRef {
  resultOf: string;
  name: string;
  path: string;
}

type Json = unknown;

interface PriorResults {
  [callId: string]: { name: string; result: Json };
}

// Map from creation-id (the tempId the client picked) to the server-assigned
// id returned by the corresponding `*/set { create }` call.
export type CreatedIds = Map<string, string>;

export function resolveArgs(args: Json, prior: PriorResults, createdIds?: CreatedIds): Json {
  return resolveArgsInner(args, prior, createdIds, true);
}

function resolveArgsInner(
  args: Json,
  prior: PriorResults,
  createdIds: CreatedIds | undefined,
  topLevel: boolean,
): Json {
  if (typeof args === "string") {
    // String creation reference: `#name` → resolved id, otherwise leave as-is.
    if (createdIds && args.length > 1 && args.startsWith("#")) {
      const tempId = args.slice(1);
      const real = createdIds.get(tempId);
      if (real !== undefined) return real;
    }
    return args;
  }
  if (args == null || typeof args !== "object") return args;
  if (Array.isArray(args)) {
    return args.map((v) => resolveArgsInner(v, prior, createdIds, false));
  }
  const o = args as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(o)) {
    // Nested `#tempId` KEYS resolve to a previously-created server id (RFC
    // 8621 §7.2). Top-level `#`-keys are reserved for result references and
    // get the structured-ref handling below.
    let outKey = k;
    if (!topLevel && k.startsWith("#") && createdIds) {
      const real = createdIds.get(k.slice(1));
      if (real !== undefined) outKey = real;
    }
    if (topLevel && k.startsWith("#")) {
      const ref = v as ResultRef;
      const r = prior[ref.resultOf];
      if (!r) {
        throw new JmapError(
          "invalidResultReference",
          `no prior call with id "${ref.resultOf}"`,
        );
      }
      if (r.name !== ref.name) {
        throw new JmapError(
          "invalidResultReference",
          `call "${ref.resultOf}" produced "${r.name}", not "${ref.name}"`,
        );
      }
      const resolved = jsonPointer(r.result, ref.path);
      if (resolved === undefined) {
        throw new JmapError(
          "invalidResultReference",
          `path "${ref.path}" did not resolve in call "${ref.resultOf}"`,
        );
      }
      out[k.slice(1)] = resolved;
    } else {
      out[outKey] = resolveArgsInner(v, prior, createdIds, false);
    }
  }
  return out;
}

// After a `*/set` succeeds, harvest its created entries so subsequent calls
// in the same request can reference them with `#tempId`.
export function harvestCreatedIds(into: CreatedIds, methodName: string, result: Json): void {
  if (!methodName.endsWith("/set") || !result || typeof result !== "object") return;
  const created = (result as { created?: unknown }).created;
  if (!created || typeof created !== "object") return;
  for (const [tempId, obj] of Object.entries(created as Record<string, unknown>)) {
    if (obj && typeof obj === "object") {
      const id = (obj as { id?: unknown }).id;
      if (typeof id === "string") into.set(tempId, id);
    }
  }
}

export function jsonPointer(input: Json, pointer: string): Json {
  // RFC 8620 §3.1.7 extends JSON Pointer with `*` — when the pointer reaches an
  // array, `*` means "for each element, apply the rest of the pointer, and
  // concatenate the resulting arrays". Without this, chained back-refs like
  // `path: "/list/*/id"` (Email/query → Email/get) silently return undefined.
  if (pointer === "" || pointer === "/") return input;
  const parts = pointer.replace(/^\//, "").split("/").map(unescape);
  return walk(input, parts, 0);
}

function walk(here: Json, parts: string[], i: number): Json {
  if (i >= parts.length) return here;
  const seg = parts[i]!;
  if (seg === "*") {
    if (!Array.isArray(here)) return undefined;
    if (i === parts.length - 1) return here;
    const out: Json[] = [];
    for (const el of here) {
      const got = walk(el, parts, i + 1);
      if (Array.isArray(got)) out.push(...got);
      else if (got !== undefined) out.push(got);
    }
    return out;
  }
  if (Array.isArray(here)) {
    return walk(here[Number(seg)], parts, i + 1);
  }
  if (here && typeof here === "object") {
    return walk((here as Record<string, Json>)[seg], parts, i + 1);
  }
  return undefined;
}

function unescape(s: string): string {
  return s.replaceAll("~1", "/").replaceAll("~0", "~");
}
