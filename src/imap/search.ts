// Compile a JMAP Email/query FilterCondition (or FilterOperator tree) to an
// imapflow SearchObject. Unsupported subtrees throw `unsupportedFilter`.

import { keywordToFlag } from "../mapping/flags.js";

export type Filter =
  | FilterOperator
  | FilterCondition;

export interface FilterOperator {
  operator: "AND" | "OR" | "NOT";
  conditions: Filter[];
}

export interface FilterCondition {
  inMailbox?: string;
  inMailboxOtherThan?: string[];
  before?: string;
  after?: string;
  minSize?: number;
  maxSize?: number;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: [string] | [string, string];
}

export class UnsupportedFilter extends Error {}

export interface ImapSearch {
  // imapflow SearchObject is a recursive plain object; we type it loosely.
  [k: string]: unknown;
}

export function compileFilter(filter: Filter): ImapSearch {
  if ("operator" in filter) {
    if (filter.operator === "AND") {
      return Object.assign({}, ...filter.conditions.map(compileFilter));
    }
    if (filter.operator === "OR") {
      return { or: filter.conditions.map(compileFilter) };
    }
    if (filter.operator === "NOT") {
      return { not: { or: filter.conditions.map(compileFilter) } };
    }
  }
  return compileLeaf(filter as FilterCondition);
}

function compileLeaf(c: FilterCondition): ImapSearch {
  const out: ImapSearch = {};
  if (c.before) out.before = new Date(c.before);
  if (c.after) out.since = new Date(c.after);
  if (c.minSize != null) out.larger = c.minSize - 1;
  if (c.maxSize != null) out.smaller = c.maxSize + 1;
  if (c.hasKeyword) out.keyword = keywordToFlag(c.hasKeyword);
  if (c.notKeyword) out.unKeyword = keywordToFlag(c.notKeyword);
  // JMAP `text` matches across from/to/cc/bcc/subject/body — IMAP TEXT, not BODY.
  // Multi-word queries become per-token TEXT criteria ANDed together; otherwise
  // the server hunts for the literal string (incl. spaces and *), scans the
  // whole mailbox, and returns nothing.
  if (c.text) Object.assign(out, compileTextTokens(c.text));
  if (c.from) out.from = c.from;
  if (c.to) out.to = c.to;
  if (c.cc) out.cc = c.cc;
  if (c.bcc) out.bcc = c.bcc;
  if (c.subject) out.subject = c.subject;
  if (c.body) out.body = c.body;
  if (c.header) {
    const [name, value] = c.header;
    out.header = { [name]: value ?? "" };
  }
  if (c.hasAttachment != null) {
    // approximation: messages with multipart/mixed root are usually attachments
    // real impl will gate on backend SEARCH=X-GM-RAW (gmail) or fallback to fetch
    throw new UnsupportedFilter("hasAttachment requires backend support");
  }
  return out;
}

function compileTextTokens(s: string): ImapSearch {
  // IMAP SEARCH does substring matching with no wildcard support; `*` and `?`
  // are sent literally and never match. Strip them and split on whitespace so
  // each remaining token becomes its own TEXT criterion.
  const tokens = s.split(/\s+/).map((t) => t.replace(/[*?]/g, "")).filter(Boolean);
  if (tokens.length === 0) return {};
  if (tokens.length === 1) return { text: tokens[0] };
  // A SearchObject can only carry one `text` key, so we can't AND multiple TEXT
  // criteria directly. De Morgan: A ∧ B ∧ … = ¬(¬A ∨ ¬B ∨ …), which imapflow's
  // not/or compiler emits correctly.
  return { not: { or: tokens.map((t) => ({ not: { text: t } })) } };
}
