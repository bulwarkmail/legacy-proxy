import {
  JmapError,
  invalidArguments,
  unsupportedFilter,
} from "../jmap/errors.js";
import { ALL_MAIL, LABEL_KEYWORD, labelKeyword, upstreamId } from "./message.js";
import type { GmailLabel } from "./store.js";

const SYSTEM: Record<string, string> = {
  INBOX: "in:inbox",
  SENT: "in:sent",
  DRAFT: "in:drafts",
  SPAM: "in:spam",
  TRASH: "in:trash",
  UNREAD: "is:unread",
  STARRED: "is:starred",
  IMPORTANT: "is:important",
  CHAT: "is:chat",
};
const NOTHING = "in:anywhere -in:anywhere";
const keyword = (value: unknown, labels: GmailLabel[]) => {
  if (value === "$seen") return "-is:unread";
  if (value === "$flagged") return "is:starred";
  if (value === "$draft") return "in:drafts";
  if (value === "$important") return "is:important";
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value) > 255 ||
    /[\x00-\x20\x7f]/.test(value)
  )
    throw invalidArguments("Invalid keyword");
  const tag = value.toLowerCase();
  if (tag.startsWith(LABEL_KEYWORD)) {
    // Tags are Gmail labels: search them as the label they are, by name, the
    // same way a folder query for the same label reads.
    const label = labels.find(
      (l) => l.type === "user" && labelKeyword(l.name) === tag,
    );
    return label ? "label:" + phrase(label.name) : NOTHING;
  }
  // Gmail has no arbitrary JMAP keywords: absent keywords match no messages.
  return NOTHING;
};
function phrase(value: unknown): string {
  if (typeof value !== "string" || !value || /[\r\n\x00]/.test(value))
    throw invalidArguments("Expected a search string");
  return '"' + value.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}
/** Free text matches every word (Gmail ANDs terms); a "quoted phrase" in the input stays a phrase. */
function words(value: unknown): string {
  if (typeof value !== "string" || /[\r\n\x00]/.test(value))
    throw invalidArguments("Expected a search string");
  const terms = (value.match(/"[^"]*"|[^\s"]+/g) ?? [])
    .map((t) => t.replace(/^"|"$/g, "").trim())
    .filter(Boolean);
  if (!terms.length) throw invalidArguments("Expected a search string");
  return terms.map(phrase).join(" ");
}
/** Gmail search is token based. Unknown JMAP conditions are explicitly rejected. */
export function gmailFilter(
  filter: unknown,
  labels: GmailLabel[],
  depth = 0,
): string {
  if (filter == null) return "";
  if (depth > 10 || typeof filter !== "object" || Array.isArray(filter))
    throw invalidArguments("Invalid filter");
  const f = filter as Record<string, unknown>;
  const mailbox = (id: unknown): string => {
    if (id === ALL_MAIL) return "";
    const raw = upstreamId(id, "l_");
    const label = labels.find((label) => label.id === raw);
    if (!label) throw invalidArguments("Unknown mailbox");
    if (SYSTEM[raw]) return SYSTEM[raw];
    if (raw.startsWith("CATEGORY_"))
      return "category:" + raw.slice(9).toLowerCase();
    return "label:" + phrase(label.name);
  };
  if (f.operator !== undefined) {
    if (
      !["AND", "OR", "NOT"].includes(String(f.operator)) ||
      !Array.isArray(f.conditions) ||
      !f.conditions.length ||
      Object.keys(f).some((k) => !["operator", "conditions"].includes(k))
    )
      throw invalidArguments("Invalid filter operator");
    const clauses = f.conditions.map((c) => gmailFilter(c, labels, depth + 1));
    // Gmail has no literal true/false. Convert these to universal/impossible searches.
    const expressions = clauses.map((c) => c || `{${NOTHING}}`);
    if (f.operator === "OR")
      return "{" + expressions.map((c) => `(${c})`).join(" ") + "}";
    if (f.operator === "NOT")
      return expressions.map((c) => `-(${c})`).join(" ");
    return clauses
      .filter(Boolean)
      .map((c) => `(${c})`)
      .join(" ");
  }
  const clauses: string[] = [];
  for (const [key, value] of Object.entries(f)) {
    if (key === "inMailbox") clauses.push(mailbox(value));
    else if (key === "inMailboxOtherThan") {
      if (!Array.isArray(value))
        throw invalidArguments(
          "inMailboxOtherThan must be an array of mailbox ids",
        );
      // Every message is also in the synthetic All mail, which would make this match everything. Clients use
      // it to leave out Trash/Junk, so treat it as "in none of these"; excluding All mail excludes everything.
      for (const id of value) {
        const clause = mailbox(id);
        clauses.push(clause ? `-(${clause})` : NOTHING);
      }
    } else if (key === "hasKeyword") clauses.push(keyword(value, labels));
    else if (key === "notKeyword") clauses.push(`-(${keyword(value, labels)})`);
    else if (["from", "to", "cc", "bcc", "subject"].includes(key))
      clauses.push(`${key}:${phrase(value)}`);
    else if (key === "text") clauses.push(words(value));
    else if (key === "hasAttachment" && typeof value === "boolean")
      clauses.push(value ? "has:attachment" : "-has:attachment");
    else if (key === "after" || key === "before") {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
        throw invalidArguments("Invalid date filter");
      clauses.push(`${key}:${Math.floor(Date.parse(value) / 1000)}`);
    } else if (key === "minSize" || key === "maxSize") {
      if (!Number.isSafeInteger(value) || (value as number) < 0)
        throw invalidArguments("Invalid size filter");
      clauses.push(
        `${key === "minSize" ? "larger" : "smaller"}:${key === "minSize" ? Math.max(0, (value as number) - 1) : value}`,
      );
    } else throw unsupportedFilter(`Unsupported Gmail filter: ${key}`);
  }
  return clauses.filter(Boolean).join(" ");
}

/**
 * Mailbox/query filter (RFC 8621 §2.3). Clients look the Inbox up by role - the
 * push preview does exactly that - so a rejected filter reads to them as "this
 * account has no Inbox" and silences their notifications.
 */
export function mailboxFilter(
  records: Record<string, unknown>[],
  filter: unknown,
): Record<string, unknown>[] {
  if (filter == null) return records;
  if (typeof filter !== "object" || Array.isArray(filter))
    throw invalidArguments("Invalid mailbox filter");
  const f = filter as Record<string, unknown>;
  if (f.operator !== undefined) {
    const conditions = f.conditions;
    if (
      !["AND", "OR", "NOT"].includes(String(f.operator)) ||
      !Array.isArray(conditions) ||
      Object.keys(f).some((k) => !["operator", "conditions"].includes(k))
    ) {
      throw invalidArguments("Invalid mailbox filter operator");
    }
    const sets = conditions.map(
      (c) => new Set(mailboxFilter(records, c).map((r) => r.id as string)),
    );
    return records.filter((r) => {
      const id = r.id as string;
      if (f.operator === "AND") return sets.every((s) => s.has(id));
      if (f.operator === "OR") return sets.some((s) => s.has(id));
      return !sets.some((s) => s.has(id));
    });
  }
  let out = records;
  for (const [key, value] of Object.entries(f)) {
    if (key === "role") {
      if (value !== null && typeof value !== "string")
        throw invalidArguments("Invalid role");
      out = out.filter((r) => (r.role ?? null) === value);
    } else if (key === "hasAnyRole") {
      if (typeof value !== "boolean")
        throw invalidArguments("Invalid hasAnyRole");
      out = out.filter((r) => (r.role != null) === value);
    } else if (key === "name") {
      if (typeof value !== "string") throw invalidArguments("Invalid name");
      const needle = value.toLowerCase();
      out = out.filter((r) =>
        String(r.name ?? "")
          .toLowerCase()
          .includes(needle),
      );
    } else if (key === "parentId") {
      // Gmail labels are flat: only top-level mailboxes exist.
      if (value !== null && typeof value !== "string")
        throw invalidArguments("Invalid parentId");
      out = value === null ? out : [];
    } else if (key === "isSubscribed") {
      if (typeof value !== "boolean")
        throw invalidArguments("Invalid isSubscribed");
      out = value ? out : [];
    } else {
      throw new JmapError(
        "unsupportedFilter",
        `Unsupported mailbox filter: ${key}`,
      );
    }
  }
  return out;
}
