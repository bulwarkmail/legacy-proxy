import { describe, expect, it } from "vitest";
import { resolveArgs, jsonPointer, harvestCreatedIds, type CreatedIds } from "../../src/jmap/refs.js";

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
  it("jsonPointer flattens through the * wildcard", () => {
    // The common JMAP chain: Email/query -> Email/get with
    // path: "/list/*/id". Without wildcard support every chained back-ref
    // returned undefined and clients silently lost ids.
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(jsonPointer({ list }, "/list/*/id")).toEqual(["a", "b", "c"]);
  });
  it("jsonPointer * keeps nested arrays flat", () => {
    const groups = [{ ids: ["a", "b"] }, { ids: ["c"] }];
    expect(jsonPointer({ groups }, "/groups/*/ids")).toEqual(["a", "b", "c"]);
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
  it("never lets a __proto__ key set the prototype of a resolved object", () => {
    const isPlain = (o: unknown) => Object.getPrototypeOf(o) === Object.prototype;
    // A key parsed from JSON, at the top and nested.
    const parsed = JSON.parse('{"accountId":"1","__proto__":{"marker":true},"update":{"__proto__":{"marker":true}}}');
    const a = resolveArgs(parsed, {}) as Record<string, Record<string, unknown>>;
    expect(isPlain(a) && isPlain(a.update)).toBe(true);
    expect("marker" in a || "marker" in a.update!).toBe(false);

    // A creation id the client named "__proto__" in the request's createdIds.
    const b = resolveArgs({ update: { "#x": { marker: true } } }, {}, new Map([["x", "__proto__"]])) as Record<
      string,
      Record<string, unknown>
    >;
    expect(isPlain(b.update)).toBe(true);
    expect("marker" in b.update!).toBe(false);

    // A top-level result reference named #__proto__.
    const c = resolveArgs(
      { "#__proto__": { resultOf: "c1", name: "Email/query", path: "/ids" } },
      { c1: { name: "Email/query", result: { ids: { marker: true } } } },
    ) as Record<string, unknown>;
    expect(isPlain(c)).toBe(true);
    expect("marker" in c).toBe(false);
  });
});

describe("harvestCreatedIds", () => {
  it("harvests creation ids from Email/import so EmailSubmission can reference them", () => {
    const ids: CreatedIds = new Map();
    harvestCreatedIds(ids, "Email/import", {
      created: { "raw-import": { id: "AQOcz7DBBrkJ", blobId: "b", threadId: "t", size: 1 } },
    });
    expect(ids.get("raw-import")).toBe("AQOcz7DBBrkJ");
    expect(resolveArgs({ create: { s: { emailId: "#raw-import" } } }, {}, ids)).toEqual({
      create: { s: { emailId: "AQOcz7DBBrkJ" } },
    });
  });

  it("harvests from */set and */copy but not from reads", () => {
    const ids: CreatedIds = new Map();
    harvestCreatedIds(ids, "Email/set", { created: { a: { id: "1" } } });
    harvestCreatedIds(ids, "Email/copy", { created: { b: { id: "2" } } });
    harvestCreatedIds(ids, "Email/get", { created: { c: { id: "3" } } });
    expect([...ids]).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });
});
