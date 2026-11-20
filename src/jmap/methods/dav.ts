// Helpers the CardDAV and CalDAV method handlers share: /set error shapes and
// JMAP patch application (RFC 8620 §5.3).

import { CardDavConflict } from "../../carddav/client.js";
import { JmapError } from "../errors.js";

/** RFC 8620 §5.3 SetError. */
export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export function setError(type: string, description?: string, properties?: string[]): SetError {
  return { type, ...(description ? { description } : {}), ...(properties ? { properties } : {}) };
}

export function errorFor(e: unknown, fallback = "serverFail"): SetError {
  if (e instanceof CardDavConflict) {
    return setError("stateMismatch", "the resource changed on the DAV server; refetch and retry");
  }
  // Keep the error's extra fields (properties, notFound) for the client.
  if (e instanceof JmapError) return e.toMethodError() as SetError;
  return setError(fallback, (e as Error)?.message);
}

/**
 * Apply an RFC 8620 §5.3 PatchObject. Keys are JSON-pointer-ish paths
 * (`emails/e1/address`); `null` removes. Top-level keys (`name`, `emails`)
 * replace the whole property, which is what the webmail client sends.
 */
export function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (parts.some((p) => p === "")) throw new JmapError("invalidPatch", `bad path "${path}"`);
    let node: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      const next = node[key];
      if (next == null || typeof next !== "object" || Array.isArray(next)) {
        if (value === null) {
          node = {};
          break;
        }
        const fresh: Record<string, unknown> = {};
        node[key] = fresh;
        node = fresh;
      } else {
        node = next as Record<string, unknown>;
      }
    }
    const leaf = parts[parts.length - 1]!;
    if (value === null || value === undefined) delete node[leaf];
    else node[leaf] = value;
  }
}
