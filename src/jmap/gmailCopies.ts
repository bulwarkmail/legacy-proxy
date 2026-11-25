// Gmail stores one message in All Mail, Important, and the folder the user
// filed it in. A conversation should name one copy. Copies are the rows that
// share a thread id and an internal date. Several different messages can share
// that same second; they are collapsed only when every folder holds the same
// number of them, so a missing copy cannot drop a message or duplicate another.

export interface GmailCopy {
  threadId: string;
  internaldate: number;
  mailboxId: number;
  uidvalidity: number;
  uid: number;
  role: string | null;
  total: number;
}

export function threadCopyScore(role: string | null): number {
  if (role === "all" || role === "important") return 100;
  if (role === "inbox") return 0;
  if (role === "sent" || role === "drafts") return 1;
  if (role === "archive") return 2;
  if (role === "junk" || role === "trash") return 3;
  return 10;
}

export function pickThreadCopy<T extends { role: string | null; total: number; uid: number }>(copies: T[]): T {
  let best = copies[0]!;
  let bestScore = threadCopyScore(best.role);
  let bestTotal = best.total;
  for (let i = 1; i < copies.length; i++) {
    const candidate = copies[i]!;
    const score = threadCopyScore(candidate.role);
    const better =
      score < bestScore ||
      (score === bestScore && candidate.total < bestTotal) ||
      (score === bestScore && candidate.total === bestTotal && candidate.uid < best.uid);
    if (!better) continue;
    best = candidate;
    bestScore = score;
    bestTotal = candidate.total;
  }
  return best;
}

export function collapseGmailCopies<T extends GmailCopy>(rows: T[]): { members: T[]; aliases: T[] } {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const row of rows) {
    const key = row.internaldate
      ? `${row.threadId}|${row.internaldate}`
      : `solo|${row.mailboxId}|${row.uid}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(row);
  }

  const members: T[] = [];
  const aliases: T[] = [];
  for (const key of order) {
    const group = groups.get(key)!;
    const buckets = new Map<number, T[]>();
    for (const row of group) {
      const bucket = buckets.get(row.mailboxId) ?? [];
      bucket.push(row);
      buckets.set(row.mailboxId, bucket);
    }
    let width = 0;
    for (const bucket of buckets.values()) {
      bucket.sort((a, b) => a.uid - b.uid);
      if (bucket.length > width) width = bucket.length;
    }
    const lengths = [...buckets.values()].map((bucket) => bucket.length);
    const aligned = lengths.every((length) => length === width);
    if (!aligned) {
      members.push(...group);
      continue;
    }
    for (let rank = 0; rank < width; rank++) {
      const slice: T[] = [];
      for (const bucket of buckets.values()) {
        const row = bucket[rank];
        if (row) slice.push(row);
      }
      const best = pickThreadCopy(slice);
      members.push(best);
      for (const row of slice) {
        if (row !== best) aliases.push(row);
      }
    }
  }
  return { members, aliases };
}
