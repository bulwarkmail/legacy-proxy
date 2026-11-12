// Drafts the webmail autosaves while the user types into a recipient field.
// The webmail's own pipeline is copied below (components/email/email-composer.tsx
// withInput, lib/email-composer-utils.ts parseRecipient/formatRecipient,
// lib/rfc5322-mailbox.ts splitMailbox), so each case sends Email/set create
// exactly the JSON the composer sends for that state of the field.
import { describe, expect, it } from "vitest";
import { buildRfc822 } from "../../src/mapping/buildMime.js";
import type { JmapError } from "../../src/jmap/errors.js";

// --- copied from the webmail (non-group path) ---
const NAME_NEEDS_QUOTING = /[,<>"@;:]/;
const unquoteName = (name: string) => {
  const t = name.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\(["\\])/g, "$1") : t;
};
function parseRecipient(s: string): { name?: string; email: string } {
  const trimmed = s.trim();
  const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (angleMatch) return { name: unquoteName(angleMatch[1]!), email: angleMatch[2]!.trim() };
  return { email: trimmed };
}
function formatRecipient(name: string | undefined, email: string): string {
  const n = name?.trim();
  if (!n || n === email) return email;
  return `${NAME_NEEDS_QUOTING.test(n) ? `"${n.replace(/(["\\])/g, "\\$1")}"` : n} <${email}>`;
}
const unquoteDisplayName = (name: string) => {
  const t = name.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\(["\\])/g, "$1").trim() : t;
};
const sanitizeDisplayName = (name: string) => (name ? unquoteDisplayName(unquoteDisplayName(name).replace(/\s*<[^<>]*>?\s*$/, "")) : "");
function splitMailbox(value: string): { name?: string; email: string } {
  const trimmed = value.trim();
  const angle = trimmed.match(/<([^<>]*)>?\s*$/);
  const email = angle ? angle[1]!.trim() : trimmed.includes("@") ? trimmed : "";
  if (!email) return { email: trimmed };
  const name = sanitizeDisplayName(trimmed.slice(0, trimmed.lastIndexOf(email)).replace(/<\s*$/, ""));
  return name && name !== email ? { name, email } : { email };
}
// What createDraft sends for the To field: chips plus the text still in the input.
const draftTo = (chips: { name?: string; email: string }[], input: string) =>
  (input.trim() ? [...chips, parseRecipient(input)] : chips).map((r) => formatRecipient(r.name, r.email)).map(splitMailbox);
// --- end of copy ---

const save = (to: { name?: string; email: string }[]) =>
  buildRfc822(
    { from: [{ name: "Alice", email: "alice@corp.example" }], to: to.length ? to : undefined, subject: "s", bodyValues: { "1": { value: "draft" } }, textBody: [{ partId: "1" }] },
    "corp.example",
  );
const chips = [{ name: "Carol", email: "carol@corp.example" }];

describe("states of the To field that save", () => {
  it.each([
    ["empty", ""],
    ["a first name", "bob"],
    ["first and last name", "Bob Smith"],
    ["a local part and its domain without dot", "jane@corp"],
    ["a complete address with a trailing space", "jane@corp.example "],
    ["a display name with a comma and a complete address", '"Doe, Jane" <jane@corp.example>'],
    ["the same typed without quotes", "Doe, Jane <jane@corp.example>"],
    ["a name and an unfinished angle address", "Jane Doe <jane"],
    ["an address in angle brackets alone", "<jane@corp.example>"],
    ["what is left of a pasted list", "c"],
    // Every typed address passes through "jane@"; the composer autosaves 2 s after
    // the last keystroke.
    ["a local part and the @", "jane@"],
    ["a name and an angle address up to the @", "Jane Doe <jane@"],
    ["the @ and a domain, local part deleted", "@corp.example"],
  ])("%s: %j", async (_label, input) => {
    await expect(save(draftTo(chips, input))).resolves.toBeInstanceOf(Buffer);
  });
});

describe("states of the To field that are refused, naming the property and the text", () => {
  // Neither can be written as one entry that is no mailbox: the comma makes two
  // entries, and the space makes a quoted local part.
  it.each([
    ["a display name typed with a comma, before the address", "Doe, Jane", "Doe, Jane"],
    ["a name and an address typed without angle brackets", "jane doe@corp.example", "jane doe@corp.example"],
  ])("%s: %j", async (_label, input, sent) => {
    const err = await save(draftTo(chips, input)).then(
      () => null,
      (e: unknown) => (e as JmapError).toMethodError(),
    );
    expect(err).toMatchObject({ type: "invalidProperties", properties: ["to"] });
    expect(err?.description).toContain(JSON.stringify(sent));
  });
});
