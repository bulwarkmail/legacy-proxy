import type { GmailApi } from "./api.js";
import { JmapError } from "../jmap/errors.js";
export interface HistoryMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
}
export interface HistoryRecord {
  id: string;
  messagesAdded?: { message: HistoryMessage }[];
  messagesDeleted?: { message: HistoryMessage }[];
  labelsAdded?: { message: HistoryMessage }[];
  labelsRemoved?: { message: HistoryMessage }[];
}
export interface HistoryResult {
  historyId: string;
  records: HistoryRecord[];
}
/** Read every page before publishing a cursor. Gmail history IDs are opaque decimal strings. */
export async function readHistory(
  api: Pick<GmailApi, "get">,
  start: string,
): Promise<HistoryResult> {
  const records: HistoryRecord[] = [];
  const tokens = new Set<string>();
  let pageToken = "";
  let historyId = start;
  do {
    let page: {
      history?: HistoryRecord[];
      historyId: string;
      nextPageToken?: string;
    };
    try {
      page = await api.get("history", 2, {
        startHistoryId: start,
        maxResults: "500",
        ...(pageToken ? { pageToken } : {}),
      });
    } catch (e) {
      if (e instanceof JmapError && e.type === "notFound")
        throw new JmapError(
          "cannotCalculateChanges",
          "Gmail history expired; reload the current mailbox",
        );
      throw e;
    }
    if (!/^\d+$/.test(page.historyId) || BigInt(page.historyId) < BigInt(start))
      throw new JmapError("serverUnavailable", "Invalid Gmail history cursor");
    for (const h of page.history ?? []) {
      if (!/^\d+$/.test(h.id))
        throw new JmapError(
          "serverUnavailable",
          "Invalid Gmail history record",
        );
      records.push(h);
    }
    historyId = page.historyId;
    pageToken = page.nextPageToken ?? "";
    if (tokens.has(pageToken) || records.length > 50_000 || tokens.size >= 100)
      throw new JmapError(
        "cannotCalculateChanges",
        "History exceeds the incremental sync limit",
      );
    if (pageToken) tokens.add(pageToken);
  } while (pageToken);
  return { historyId, records };
}
export function affected(records: HistoryRecord[]): {
  messages: string[];
  threads: string[];
} {
  const messages = new Set<string>(),
    threads = new Set<string>();
  for (const h of records)
    for (const group of [
      h.messagesAdded,
      h.messagesDeleted,
      h.labelsAdded,
      h.labelsRemoved,
    ])
      for (const { message: m } of group ?? []) {
        messages.add(m.id);
        if (m.threadId) threads.add(m.threadId);
      }
  return { messages: [...messages], threads: [...threads] };
}
/** Messages Gmail added to this account, with the labels the history record carried (if any). */
export function addedMessages(
  records: HistoryRecord[],
): Map<string, string[] | undefined> {
  const added = new Map<string, string[] | undefined>();
  for (const h of records)
    for (const { message: m } of h.messagesAdded ?? [])
      added.set(m.id, m.labelIds);
  // A message added and then removed inside the same window is not a delivery.
  for (const h of records)
    for (const { message: m } of h.messagesDeleted ?? []) added.delete(m.id);
  return added;
}

/** Labels that mean "not a new arrival the user should be woken for". */
export const NOT_DELIVERED = ["SPAM", "TRASH", "DRAFT", "SENT"];
export const isDelivery = (
  labels: string[] | undefined,
): boolean | undefined =>
  labels === undefined
    ? undefined
    : labels.includes("INBOX") &&
      !labels.some((l) => NOT_DELIVERED.includes(l));

export function emailDelta(
  records: HistoryRecord[],
  original: (id: string) => string,
) {
  // Whether an ID existed at the start and at the end. A create then delete is invisible.
  const states = new Map<string, { before: boolean; after: boolean }>();
  const event = (native: string, kind: "create" | "destroy" | "update") => {
    const id = "m_" + original(native);
    const s = states.get(id) ?? { before: kind !== "create", after: true };
    if (kind !== "update" || s.after) s.after = kind !== "destroy";
    states.set(id, s);
  };
  for (const h of records) {
    for (const x of h.messagesDeleted ?? []) event(x.message.id, "destroy");
    for (const x of h.messagesAdded ?? []) event(x.message.id, "create");
    for (const x of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])])
      event(x.message.id, "update");
  }
  const created: string[] = [],
    updated: string[] = [],
    destroyed: string[] = [];
  for (const [id, s] of states) {
    if (!s.before && s.after) created.push(id);
    else if (s.before && !s.after) destroyed.push(id);
    else if (s.before && s.after) updated.push(id);
  }
  return { created, updated, destroyed };
}
