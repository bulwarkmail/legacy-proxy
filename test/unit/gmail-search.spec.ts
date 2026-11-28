import { expect, it } from "vitest";
import { isGmailAccountWideContentSearch } from "../../src/jmap/gmailSearch.js";

it("sends an account-wide Gmail text search to one folder", () => {
  expect(isGmailAccountWideContentSearch({ text: "invoice" })).toEqual({ excludedIds: [] });
  expect(
    isGmailAccountWideContentSearch({
      operator: "AND",
      conditions: [{ text: "invoice" }, { notKeyword: "$seen" }],
    }),
  ).toEqual({ excludedIds: [] });
  expect(isGmailAccountWideContentSearch({ hasAttachment: true })).toEqual({ excludedIds: [] });
  expect(
    isGmailAccountWideContentSearch({
      operator: "AND",
      conditions: [{ text: "invoice" }, { inMailboxOtherThan: ["trash-id", "junk-id"] }],
    }),
  ).toEqual({ excludedIds: ["trash-id", "junk-id"] });
});

it("leaves a folder search, a junk search, and an empty term on the normal path", () => {
  expect(
    isGmailAccountWideContentSearch({
      operator: "AND",
      conditions: [{ inMailbox: "inbox" }, { text: "invoice" }],
    }),
  ).toBeNull();
  expect(
    isGmailAccountWideContentSearch({
      operator: "AND",
      conditions: [{ text: "invoice" }, { hasKeyword: "$junk" }],
    }),
  ).toBeNull();
  expect(isGmailAccountWideContentSearch({ text: "" })).toBeNull();
  expect(isGmailAccountWideContentSearch({ notKeyword: "$seen" })).toBeNull();
  expect(isGmailAccountWideContentSearch({ operator: "OR", conditions: [{ text: "a" }, { text: "b" }] })).toBeNull();
});
