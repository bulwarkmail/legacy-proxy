import { expect, it } from "vitest";
import { collapseGmailCopies, pickThreadCopy } from "../../src/jmap/gmailCopies.js";

const copy = (
  partial: Partial<Parameters<typeof collapseGmailCopies>[0][number]> & { uid: number; role: string | null },
) => ({
  threadId: "T",
  internaldate: 1_000,
  mailboxId: partial.role === "inbox" ? 1 : 2,
  uidvalidity: 1,
  total: partial.role === "all" ? 100_000 : 3,
  ...partial,
});

it("keeps the inbox copy of one message stored in All Mail and Important", () => {
  expect(
    pickThreadCopy([
      { role: "all", total: 100_000, uid: 1 },
      { role: "important", total: 40_000, uid: 2 },
      { role: "inbox", total: 3, uid: 3 },
    ]).role,
  ).toBe("inbox");
});

it("keeps every message sent in the same second, and still drops aligned copies", () => {
  const collapsed = collapseGmailCopies([
    copy({ uid: 10, role: "inbox", mailboxId: 1 }),
    copy({ uid: 11, role: "inbox", mailboxId: 1 }),
    copy({ uid: 100, role: "all", mailboxId: 2, total: 100_000 }),
    copy({ uid: 101, role: "all", mailboxId: 2, total: 100_000 }),
  ]);
  expect(collapsed.members.map((row) => row.uid)).toEqual([10, 11]);
  expect(collapsed.aliases.map((row) => row.uid)).toEqual([100, 101]);
});

it("does not drop a message when the folders do not hold the same set", () => {
  const collapsed = collapseGmailCopies([
    copy({ uid: 100, role: "all", mailboxId: 2, total: 100_000 }),
    copy({ uid: 101, role: "all", mailboxId: 2, total: 100_000 }),
    copy({ uid: 10, role: "inbox", mailboxId: 1 }),
  ]);
  expect(collapsed.members.map((row) => row.uid).sort((a, b) => a - b)).toEqual([10, 100, 101]);
  expect(collapsed.aliases).toEqual([]);
});
