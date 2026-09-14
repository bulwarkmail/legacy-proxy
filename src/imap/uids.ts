import type { FetchMessageObject, FetchQueryObject, ImapFlow } from "imapflow";

// Some IMAP servers cap the command line (MDaemon and Kerio Connect reject or
// drop the connection; RFC 7162 §4 asks clients to stay under 8192 octets), so
// a UID list must never go out as one flat comma list. imapflow does not guard
// against this: a number[] range is sent as `range.join(",")`, uncompressed.
const MAX_SET_BYTES = 4000;

/**
 * Pack UIDs into IMAP sequence sets ("1:3,5,9:12"), split so no set exceeds
 * `maxBytes`. Input may be unsorted or contain duplicates. Contiguous runs
 * collapse into one range, so a dense folder of any size stays one command;
 * only sparse sets (a search hitting every other message) need several.
 */
export function uidSets(uids: Iterable<number>, maxBytes = MAX_SET_BYTES): string[] {
  const sorted = [...new Set(uids)]
    .filter((u) => Number.isInteger(u) && u > 0)
    .sort((a, b) => a - b);
  const sets: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i]!;
    i++;
    const part = start === end ? `${start}` : `${start}:${end}`;
    if (cur && cur.length + 1 + part.length > maxBytes) {
      sets.push(cur);
      cur = part;
    } else {
      cur = cur ? `${cur},${part}` : part;
    }
  }
  if (cur) sets.push(cur);
  return sets;
}

/**
 * UID FETCH over an arbitrary UID list, one bounded command per sequence set.
 * Drop-in for `client.fetch(uids, query, { uid: true })`.
 */
export async function* fetchByUid(
  client: ImapFlow,
  uids: Iterable<number>,
  query: FetchQueryObject,
): AsyncGenerator<FetchMessageObject> {
  for (const set of uidSets(uids)) {
    yield* client.fetch(set, query, { uid: true });
  }
}
