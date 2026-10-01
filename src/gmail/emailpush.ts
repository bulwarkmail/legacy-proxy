/**
 * Delivery notifications that name the mail, per draft-ietf-jmap-emailpush.
 *
 * A bare `EmailDelivery` state change says only "something arrived". The
 * client then has to guess which message it was - in practice "the newest
 * unread in the Inbox", which is right only while mail is read in the order
 * it arrives. With an `emailPush` config the subscriber says, once, which
 * messages are worth waking it for and which properties it wants back, and
 * every delivery carries the answer:
 *
 *   {"@type":"EmailPush","accountId":"…","emails":[{"id":"…"}],"state":"…"}
 *
 * The filter is the subscriber's, not ours: whoever registers it decides
 * whether Gmail's spam verdict - the `$junk` keyword, or the SPAM label that
 * is the Junk-role mailbox here - is reason enough to stay quiet. This module
 * only validates what it can honestly evaluate and then evaluates it.
 */
import { JmapError } from "../jmap/errors.js";

/** One account's standing request: which deliveries to push, and what to say about them. */
export interface EmailPushConfig {
  filter: unknown;
  properties: string[];
  urgency: "low" | "normal" | "high";
}

/**
 * Properties a push payload may carry.
 *
 * Small and header-derived on purpose: a Web Push payload has a few kilobytes
 * to live in, and the body of a message belongs behind an authenticated read,
 * not in a notification that travels through a relay. Bodies, attachments and
 * raw headers are therefore refused rather than truncated.
 */
export const PUSH_PROPERTIES: ReadonlySet<string> = new Set([
  "id",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "sentAt",
  "messageId",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "preview",
]);

/** Properties the filter conditions below read, fetched whether or not the subscriber asked for them. */
const FILTER_PROPERTIES = ["id", "mailboxIds", "keywords"] as const;

const URGENCIES = new Set(["low", "normal", "high"]);

// Annotated on the variable, not just the arrow: that is what lets the
// compiler treat a call as the end of the road and narrow what follows.
const fail: (description: string) => never = (description) => {
  throw new JmapError("invalidProperties", description);
};

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);

/**
 * Checks a filter is one we can answer for, condition by condition.
 *
 * Refusing at registration is the only honest moment: a filter accepted here
 * and quietly ignored at delivery time would push the user's junk mail to
 * their phone, which is the opposite of what they asked for. The supported
 * set is what a delivery decision can be made from without reading the
 * message body - where it was filed and what it was flagged with.
 */
function checkFilter(filter: unknown, depth = 0): void {
  if (!isPlainObject(filter)) fail("emailPush filter must be an object");
  if (depth > 8) fail("emailPush filter is nested too deeply");
  if (typeof filter.operator === "string") {
    if (!["AND", "OR", "NOT"].includes(filter.operator))
      fail("Unsupported emailPush filter operator: " + filter.operator);
    if (!Array.isArray(filter.conditions))
      fail("emailPush filter conditions must be an array");
    for (const condition of filter.conditions) checkFilter(condition, depth + 1);
    return;
  }
  for (const [name, value] of Object.entries(filter)) {
    switch (name) {
      case "inMailbox":
        if (typeof value !== "string") fail("inMailbox must be a Mailbox id");
        break;
      case "inMailboxOtherThan":
        if (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
          fail("inMailboxOtherThan must be an array of Mailbox ids");
        break;
      case "hasKeyword":
      case "notKeyword":
        if (typeof value !== "string") fail(name + " must be a keyword");
        break;
      default:
        // Everything else - text search, dates, sizes - would need a read per
        // delivery or a capability this backend does not have.
        fail("Unsupported emailPush filter condition: " + name);
    }
  }
}

/** Reads the `emailPush` property of a PushSubscription/set, or throws telling the client why not. */
export function parseEmailPush(
  value: unknown,
  accountId: string,
): Record<string, EmailPushConfig> | null {
  if (value === null || value === undefined) return null;
  if (!isPlainObject(value)) fail("emailPush must be an object or null");
  const out: Record<string, EmailPushConfig> = {};
  for (const [account, raw] of Object.entries(value)) {
    // One account per bridge connection: a key naming any other account is a
    // request we could never honour, and silence would look like support.
    if (account !== accountId)
      fail("No access to one of the accounts in the emailPush map");
    if (!isPlainObject(raw)) fail("EmailPushConfig must be an object");
    for (const key of Object.keys(raw))
      if (!["filter", "properties", "urgency"].includes(key))
        fail("Unknown EmailPushConfig property: " + key);
    checkFilter(raw.filter ?? {});
    const properties = raw.properties;
    if (properties !== undefined && properties !== null) {
      if (!Array.isArray(properties))
        fail("EmailPushConfig properties must be an array");
      for (const property of properties) {
        if (typeof property !== "string" || !PUSH_PROPERTIES.has(property))
          fail("Unsupported emailPush property: " + String(property));
      }
    }
    const urgency = raw.urgency ?? "normal";
    if (typeof urgency !== "string" || !URGENCIES.has(urgency))
      fail("Invalid urgency value");
    out[account] = {
      filter: raw.filter ?? {},
      properties: (properties as string[] | undefined) ?? ["id"],
      urgency: urgency as EmailPushConfig["urgency"],
    };
  }
  return out;
}

/** Every property that has to be read to serve these configs, filters included. */
export function propertiesFor(
  configs: readonly EmailPushConfig[],
): string[] {
  const wanted = new Set<string>(FILTER_PROPERTIES);
  for (const config of configs) for (const property of config.properties) wanted.add(property);
  return [...wanted];
}

const truthyKeys = (value: unknown): Set<string> =>
  new Set(
    isPlainObject(value)
      ? Object.entries(value)
          .filter(([, on]) => on)
          .map(([key]) => key)
      : [],
  );

/** Whether one delivered message is one this config asked to hear about. */
export function matchesFilter(
  filter: unknown,
  email: Record<string, unknown>,
): boolean {
  if (!isPlainObject(filter)) return true;
  if (typeof filter.operator === "string") {
    const conditions = Array.isArray(filter.conditions) ? filter.conditions : [];
    if (filter.operator === "AND")
      return conditions.every((c) => matchesFilter(c, email));
    if (filter.operator === "OR")
      return conditions.some((c) => matchesFilter(c, email));
    return !conditions.some((c) => matchesFilter(c, email));
  }
  // An empty condition object is "everything", the same as no filter at all.
  const mailboxes = truthyKeys(email.mailboxIds);
  const keywords = truthyKeys(email.keywords);
  for (const [name, value] of Object.entries(filter)) {
    switch (name) {
      case "inMailbox":
        if (!mailboxes.has(value as string)) return false;
        break;
      case "inMailboxOtherThan":
        // RFC 8621: the message must be in at least one mailbox that is not
        // in the list. Mail filed only into Junk fails this and stays quiet.
        if (
          ![...mailboxes].some((id) => !(value as string[]).includes(id))
        )
          return false;
        break;
      case "hasKeyword":
        if (!keywords.has(value as string)) return false;
        break;
      case "notKeyword":
        if (keywords.has(value as string)) return false;
        break;
      default:
        // Never registered, so never reached; refuse rather than over-notify.
        return false;
    }
  }
  return true;
}

/** The subscriber's view of a delivered message: the properties it asked for, nothing else. */
export function projectEmail(
  email: Record<string, unknown>,
  properties: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const property of properties)
    if (property in email) out[property] = email[property];
  return out;
}
