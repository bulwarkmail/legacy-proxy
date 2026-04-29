import { describe, expect, it } from "vitest";
import { resolveArgs, jsonPointer } from "../../src/jmap/refs.js";

describe("JMAP back-references", () => {
  it("resolves a simple #ref", () => {
    const prior = { c1: { name: "Mailbox/get", result: { list: [{ id: "abc" }] } } };
    const args = { "#ids": { resultOf: "c1", name: "Mailbox/get", path: "/list/0/id" } };
    expect(resolveArgs(args, prior)).toEqual({ ids: "abc" });
  });
  it("rejects when previous call mismatches", () => {
    const prior = { c1: { name: "Foo/get", result: {} } };
    const args = { "#ids": { resultOf: "c1", name: "Mailbox/get", path: "/x" } };
    expect(() => resolveArgs(args, prior)).toThrow(/invalidResultReference/);
  });
  it("jsonPointer walks objects and arrays", () => {
    expect(jsonPointer({ a: { b: [10, 20, 30] } }, "/a/b/2")).toBe(30);
  });
  it("does not treat nested #-prefixed keys as result references", () => {
    // EmailSubmission/set's onSuccessUpdateEmail uses `#tempId` keys per
    // RFC 8621 §7.3. These must pass through unchanged so the method
    // handler can resolve them against just-created submissions.
    const args = {
      accountId: "1",
      onSuccessUpdateEmail: {
        "#sub1": { "mailboxIds/abc": null, "mailboxIds/def": true },
      },
    };
    expect(resolveArgs(args, {})).toEqual(args);
  });
  it("resolves string creation references inside nested structures", () => {
    const createdIds = new Map([["new-email", "real-id-42"]]);
    const args = {
      accountId: "1",
      create: { sub1: { emailId: "#new-email" } },
    };
    expect(resolveArgs(args, {}, createdIds)).toEqual({
      accountId: "1",
      create: { sub1: { emailId: "real-id-42" } },
    });
  });
});
