/**
 * Run `fn` over `items` with a bounded worker pool, preserving input order in
 * the returned array regardless of which items finish first.
 *
 * Used where a proxy request fans out into many independent backend round
 * trips — CardDAV multiget chunks, per-folder IMAP scans — and the serial
 * version would cost the sum of their latencies instead of the maximum. The
 * bound matters: it keeps one user's request from opening an unbounded burst
 * of work against a shared server.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
