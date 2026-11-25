import { expect, it } from "vitest";
import { isGmailAccountWideContentSearch } from "../../src/jmap/gmailSearch.js";

it("sends an account-wide Gmail text search to one folder", () => {
  expect(isGmailAccountWideContentSearch({ text: "invoice" })).toBe(true);
  expect(
    isGmailAccountWideContentSearch({
      operator: "AND",
      conditions: [{ text: "invoice" }, { notKeyword: "$seen" }],
    }),
  ).toBe(true);
  expect(isGmailAccountWideContentSearch({ hasAttachment: true })).toBe(true);
});

it("leaves a folder search, a junk search, and an empty term on the normal path", () => {
  expect(
    isGmailAccountWideContentSearch({
      operator: "AND",
      conditions: [{ inMailbox: "inbox" }, { text: "invoice" }],
    }),
  ).toBe(false);
  expect(
    isGmailAccountWideContentSearch({
      operator: "AND",
      conditions: [{ text: "invoice" }, { hasKeyword: "$junk" }],
    }),
  ).toBe(false);
  expect(isGmailAccountWideContentSearch({ text: "" })).toBe(false);
  expect(isGmailAccountWideContentSearch({ notKeyword: "$seen" })).toBe(false);
  expect(isGmailAccountWideContentSearch({ operator: "OR", conditions: [{ text: "a" }, { text: "b" }] })).toBe(false);
});
