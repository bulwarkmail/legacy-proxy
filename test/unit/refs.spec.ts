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
});
