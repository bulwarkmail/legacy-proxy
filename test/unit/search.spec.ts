import { describe, expect, it } from "vitest";
import { compileFilter, UnsupportedFilter } from "../../src/imap/search.js";

describe("Email/query filter compiler", () => {
  it("compiles a leaf condition", () => {
    expect(compileFilter({ subject: "hello" })).toEqual({ subject: "hello" });
  });
  it("compiles AND as merge", () => {
    expect(
      compileFilter({
        operator: "AND",
        conditions: [{ from: "alice@example.com" }, { hasKeyword: "$flagged" }],
      }),
    ).toEqual({ from: "alice@example.com", keyword: "\\Flagged" });
  });
  it("compiles OR", () => {
    const r = compileFilter({
      operator: "OR",
      conditions: [{ subject: "a" }, { subject: "b" }],
    }) as { or: unknown[] };
    expect(r.or).toHaveLength(2);
  });
  it("rejects hasAttachment when backend lacks support", () => {
    expect(() => compileFilter({ hasAttachment: true })).toThrow(UnsupportedFilter);
  });
});
