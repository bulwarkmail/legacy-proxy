import { JmapError } from "../jmap/errors.js";
import { ALL_MAIL, LABEL_KEYWORD, labelKeyword, type GmailMessage } from "./message.js";
import type { GmailLabel } from "./store.js";

const invalid = (description: string): never => {
  throw new JmapError("invalidProperties", description);
};
const KEYWORDS: Record<string, { label: string; inverse?: boolean }> = {
  $seen: { label: "UNREAD", inverse: true },
  $flagged: { label: "STARRED" },
  $important: { label: "IMPORTANT" },
};
export const writableLabel = (label: GmailLabel): boolean =>
  label.type === "user" || ["INBOX", "SPAM", "TRASH"].includes(label.id);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Expected an object");
  return value as Record<string, unknown>;
}
/** Validate the entire patch before any upstream write. Only requested labels change. */
export function emailPatch(
  message: GmailMessage,
  patch: unknown,
  labels: GmailLabel[],
): { addLabelIds: string[]; removeLabelIds: string[] } {
  const p = object(patch);
  const current = new Set(message.labelIds ?? []);
  const desired = new Map<string, boolean>();
  const set = (label: string, value: boolean) => {
    if (desired.has(label) && desired.get(label) !== value)
      invalid("Conflicting mailbox and keyword changes");
    desired.set(label, value);
  };
  const mailbox = (id: string, value: boolean, explicit = true) => {
    if (id === ALL_MAIL) {
      if (!value) invalid("All mail cannot be removed");
      return;
    }
    const label = labels.find((l) => "l_" + l.id === id);
    if (!label) invalid("Unknown mailbox");
    if (!writableLabel(label!)) {
      if (explicit && current.has(label!.id) !== value) invalid("System mailbox is read-only");
      return;
    }
    set(label!.id, value);
  };
  /** The user label a tag keyword names, if the account still has one. Keywords are case-insensitive. */
  const tagged = (key: string) =>
    labels.find((l) => l.type === "user" && labelKeyword(l.name) === key.toLowerCase());
  const keyword = (key: string, value: boolean) => {
    const mapped = Object.hasOwn(KEYWORDS, key) ? KEYWORDS[key] : undefined;
    if (mapped) {
      set(mapped.label, mapped.inverse ? !value : value);
      return;
    }
    if (key.toLowerCase().startsWith(LABEL_KEYWORD)) {
      const label = tagged(key);
      if (label) return set(label.id, value);
      // Removing a tag no label answers to leaves the message as it is;
      // adding one would have to invent a label, which Email/set may not do.
      if (!value) return;
      invalid("Unknown label keyword");
    }
    if (key === "$draft" && current.has("DRAFT") === value) return;
    if (!value && key !== "$draft") return; // Removing an absent custom keyword is a no-op.
    invalid("Unsupported keyword change");
  };
  for (const [key, value] of Object.entries(p)) {
    if (key === "mailboxIds") {
      if (Object.keys(p).some((k) => k.startsWith("mailboxIds/"))) invalid("Overlapping mailbox patch paths");
      const ids = object(value);
      if (!Object.keys(ids).length) invalid("A message must remain in a mailbox");
      for (const [id, v] of Object.entries(ids)) {
        if (v !== true) invalid("Mailbox membership must be true");
        mailbox(id, true);
      }
      // Gmail All mail is the archive destination. Preserve user labels when archiving.
      const archive = Object.keys(ids).length === 1 && ids[ALL_MAIL] === true;
      for (const l of labels)
        if (writableLabel(l) && !("l_" + l.id in ids) && (!archive || l.type !== "user")) set(l.id, false);
    } else if (key === "keywords") {
      if (Object.keys(p).some((k) => k.startsWith("keywords/"))) invalid("Overlapping keyword patch paths");
      const keywords = object(value);
      for (const [k, v] of Object.entries(keywords)) {
        if (v !== true) invalid("Keyword value must be true");
        keyword(k, true);
      }
      for (const k of Object.keys(KEYWORDS)) if (!(k in keywords)) keyword(k, false);
      // Setting keywords wholesale without naming a single tag is how a client
      // marks a message read or flagged, not how it strips its labels: only a
      // patch that mentions tags is allowed to remove them.
      const asked = new Set(Object.keys(keywords).map((k) => k.toLowerCase()));
      if ([...asked].some((k) => k.startsWith(LABEL_KEYWORD)))
        for (const l of labels) {
          const k = l.type === "user" ? labelKeyword(l.name) : null;
          if (k && !asked.has(k)) set(l.id, false);
        }
      if (current.has("DRAFT") && !keywords.$draft) invalid("Draft status cannot be changed");
    } else if (key.startsWith("mailboxIds/") || key.startsWith("keywords/")) {
      if (value !== true && value !== null) invalid("Patch value must be true or null");
      const [parent, token, ...rest] = key.split("/");
      if (!token || rest.length || /~(?:[^01]|$)/.test(token)) invalid("Invalid patch path");
      const id = token!.replace(/~1/g, "/").replace(/~0/g, "~");
      if (parent === "mailboxIds") mailbox(id, value === true);
      else keyword(id, value === true);
    } else invalid("Only mailboxIds and keywords can be updated");
  }
  const addLabelIds: string[] = [],
    removeLabelIds: string[] = [];
  for (const [id, value] of desired)
    if (current.has(id) !== value) (value ? addLabelIds : removeLabelIds).push(id);
  if (addLabelIds.length > 100 || removeLabelIds.length > 100) invalid("Too many label changes");
  return { addLabelIds, removeLabelIds };
}
export function labelInput(input: unknown, create: boolean): { name: string } {
  const p = object(input);
  for (const [key, value] of Object.entries(p)) {
    if (key === "name") continue;
    if (
      create &&
      (((key === "parentId" || key === "role") && value === null) ||
        (key === "isSubscribed" && value === true) ||
        (key === "sortOrder" && value === 0))
    )
      continue;
    invalid("Only flat label names are supported");
  }
  if (
    typeof p.name !== "string" ||
    !p.name.trim() ||
    Buffer.byteLength(p.name) > 225 ||
    /[\x00-\x1f]/.test(p.name)
  )
    invalid("Invalid label name");
  return { name: p.name as string };
}
