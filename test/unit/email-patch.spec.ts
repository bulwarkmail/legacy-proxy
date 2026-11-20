import { describe, expect, it } from "vitest";
import { __test } from "../../src/jmap/methods/email.js";

const { resolvePatch, computeNewMailboxIds } = __test;

describe("Email/set patch resolution", () => {
  it("collects writable fields and rejected fields separately", () => {
    const r = resolvePatch({
      "keywords/$seen": true,
      "mailboxIds/abc": true,
      subject: "no",
    });
    expect(r.keywordAdd.has("$seen")).toBe(true);
    expect(r.mailboxAdd.has("abc")).toBe(true);
    expect(r.rejectedProperties).toEqual(["subject"]);
  });

  it("treats `mailboxIds/X = null` as a remove from current mailbox", () => {
    // Regression: the prior implementation collected only `=true` entries,
    // making `{mailboxIds/Inbox: null}` resolve to `[]` and triggering the
    // "all mailboxes removed -> destroy" branch. Now removals subtract from
    // the current set.
    const r = resolvePatch({ "mailboxIds/Inbox": null });
    const next = computeNewMailboxIds(r, "Inbox");
    expect(next).toEqual([]);
  });

  it("keeps the current mailbox when removing a different one", () => {
    const r = resolvePatch({ "mailboxIds/Trash": null });
    const next = computeNewMailboxIds(r, "Inbox");
    expect(next).toEqual(["Inbox"]);
  });

  it("partial patch with adds and the current mailbox keeps both", () => {
    const r = resolvePatch({ "mailboxIds/Sent": true });
    const next = computeNewMailboxIds(r, "Inbox");
    expect(next?.sort()).toEqual(["Inbox", "Sent"]);
  });

  it("full mailboxIds replacement wins over partial", () => {
    const r = resolvePatch({
      mailboxIds: { Inbox: true, Sent: true },
      "mailboxIds/Trash": true,
    });
    const next = computeNewMailboxIds(r, "Drafts");
    expect(next?.sort()).toEqual(["Inbox", "Sent"]);
  });

  it("keywords/X false is treated as remove", () => {
    const r = resolvePatch({ "keywords/$seen": false, "keywords/$flagged": true });
    expect(r.keywordRemove.has("$seen")).toBe(true);
    expect(r.keywordAdd.has("$flagged")).toBe(true);
  });

  it("decodes the JSON Pointer escapes of a keyword path", () => {
    // Bulwark nests tags with "/", sent as "~1" (RFC 8620 §5.3, RFC 6901).
    const r = resolvePatch({
      "keywords/$label:work~1clients": true,
      "keywords/$label:old~1tag": null,
    });
    expect([...r.keywordAdd]).toEqual(["$label:work/clients"]);
    expect([...r.keywordRemove]).toEqual(["$label:old/tag"]);
  });

  it("reads ~01 as a literal ~1, not as a slash", () => {
    const r = resolvePatch({ "keywords/$label:a~01b": null });
    expect([...r.keywordRemove]).toEqual(["$label:a~1b"]);
  });

  it("decodes the JSON Pointer escapes of a mailbox path", () => {
    const r = resolvePatch({ "mailboxIds/a~1b": true });
    expect([...r.mailboxAdd]).toEqual(["a/b"]);
  });
});
