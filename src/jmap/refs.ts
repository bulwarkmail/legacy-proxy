// Resolve back-references in a method call's arguments per RFC 8620 §3.7.
// "#name" pointers reach into a previously-completed method's response, with
// optional `resultOf` (call-id) and `path` (a JSON Pointer fragment).

export interface ResultRef {
  resultOf: string;
  name: string;
  path: string;
}

type Json = unknown;

interface PriorResults {
  [callId: string]: { name: string; result: Json };
}

export function resolveArgs(args: Json, prior: PriorResults): Json {
  if (args == null || typeof args !== "object") return args;
  if (Array.isArray(args)) return args.map((v) => resolveArgs(v, prior));
  const o = args as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(o)) {
    if (k.startsWith("#")) {
      const ref = v as ResultRef;
      const r = prior[ref.resultOf];
      if (!r) throw new Error(`invalidResultReference: missing call ${ref.resultOf}`);
      if (r.name !== ref.name) {
        throw new Error(`invalidResultReference: ${ref.resultOf} produced ${r.name}, not ${ref.name}`);
      }
      out[k.slice(1)] = jsonPointer(r.result, ref.path);
    } else {
      out[k] = resolveArgs(v, prior);
    }
  }
  return out;
}

export function jsonPointer(input: Json, pointer: string): Json {
  if (pointer === "" || pointer === "/") return input;
  const parts = pointer.replace(/^\//, "").split("/").map(unescape);
  let here: Json = input;
  for (const seg of parts) {
    if (seg === "*" && Array.isArray(here)) {
      here = here;
      continue;
    }
    if (Array.isArray(here)) {
      if (seg === "*") continue;
      here = here[Number(seg)];
    } else if (here && typeof here === "object") {
      here = (here as Record<string, Json>)[seg];
    } else {
      return undefined;
    }
  }
  return here;
}

function unescape(s: string): string {
  return s.replaceAll("~1", "/").replaceAll("~0", "~");
}
