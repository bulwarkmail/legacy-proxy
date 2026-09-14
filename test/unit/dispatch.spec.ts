// Independent read-only calls in one envelope are dispatched together rather
// than one after another. What must survive that: response order, the
// capability gate, and above all the barrier -- a call that references an
// earlier one has to see the earlier one's result, which means it must not be
// grouped with it.

import { describe, expect, it } from "vitest";
import { dispatch, hasCrossCallReference, type MethodCall } from "../../src/jmap/router.js";

const CORE = "urn:ietf:params:jmap:core";

// Core/echo touches nothing but the envelope, so the surrounding context can
// be inert -- these tests are about the dispatch loop, not the handlers.
const ctx = {
  cfg: { limits: { maxCallsInRequest: 100 } },
  pool: {},
  store: {},
  account: { id: 7 },
  dispatcher: {},
} as unknown as Parameters<typeof dispatch>[1];

function echo(id: string, args: Record<string, unknown> = {}): MethodCall {
  return ["Core/echo", args, id];
}

describe("hasCrossCallReference", () => {
  it("spots a top-level result reference", () => {
    expect(
      hasCrossCallReference({ "#ids": { resultOf: "a", name: "Email/query", path: "/ids" } }),
    ).toBe(true);
  });

  it("spots a creation reference nested in a value", () => {
    expect(hasCrossCallReference({ update: { x: { mailboxIds: ["#draft"] } } })).toBe(true);
  });

  it("spots a creation reference used as a nested key", () => {
    expect(hasCrossCallReference({ onSuccessUpdateEmail: { "#sub": { keywords: {} } } })).toBe(true);
  });

  it("passes plain arguments", () => {
    expect(hasCrossCallReference({ accountId: "7", ids: ["a", "b"], limit: 50 })).toBe(false);
  });

  it("does not mistake a bare # for a reference", () => {
    expect(hasCrossCallReference({ subject: "#" })).toBe(false);
  });
});

describe("dispatch", () => {
  it("returns responses in the order the client sent them", async () => {
    const out = await dispatch(
      {
        using: [CORE],
        methodCalls: [echo("a", { n: 1 }), echo("b", { n: 2 }), echo("c", { n: 3 })],
      },
      ctx,
    );

    expect(out.methodResponses.map((r) => r[2])).toEqual(["a", "b", "c"]);
    expect(out.methodResponses.map((r) => (r[1] as { n: number }).n)).toEqual([1, 2, 3]);
  });

  it("resolves a back-reference to the call immediately before it", async () => {
    // If these two were dispatched together, "b" would run before "a" landed
    // in `prior` and fail with invalidResultReference.
    const out = await dispatch(
      {
        using: [CORE],
        methodCalls: [
          echo("a", { value: "from-a" }),
          echo("b", { "#copied": { resultOf: "a", name: "Core/echo", path: "/value" } }),
        ],
      },
      ctx,
    );

    expect(out.methodResponses[1]![0]).toBe("Core/echo");
    expect(out.methodResponses[1]![1]).toEqual({ copied: "from-a" });
  });

  it("keeps a back-reference working across a run of parallel calls", async () => {
    const out = await dispatch(
      {
        using: [CORE],
        methodCalls: [
          echo("a", { value: "first" }),
          echo("b", { n: 2 }),
          echo("c", { n: 3 }),
          echo("d", { "#copied": { resultOf: "a", name: "Core/echo", path: "/value" } }),
        ],
      },
      ctx,
    );

    expect(out.methodResponses.map((r) => r[2])).toEqual(["a", "b", "c", "d"]);
    expect(out.methodResponses[3]![1]).toEqual({ copied: "first" });
  });

  it("reports a broken reference as an error on that call alone", async () => {
    const out = await dispatch(
      {
        using: [CORE],
        methodCalls: [
          echo("a", { n: 1 }),
          echo("b", { "#x": { resultOf: "nope", name: "Core/echo", path: "/n" } }),
          echo("c", { n: 3 }),
        ],
      },
      ctx,
    );

    expect(out.methodResponses[0]![0]).toBe("Core/echo");
    expect(out.methodResponses[1]![0]).toBe("error");
    expect((out.methodResponses[1]![1] as { type: string }).type).toBe("invalidResultReference");
    expect(out.methodResponses[2]![0]).toBe("Core/echo");
  });

  it("still gates on the negotiated capability set", async () => {
    const out = await dispatch(
      { using: [], methodCalls: [echo("a"), echo("b")] },
      ctx,
    );

    expect(out.methodResponses.map((r) => r[0])).toEqual(["error", "error"]);
    expect((out.methodResponses[0]![1] as { type: string }).type).toBe("unknownMethod");
  });

  it("rejects an envelope over the call limit", async () => {
    const tiny = { ...ctx, cfg: { limits: { maxCallsInRequest: 2 } } } as typeof ctx;
    await expect(
      dispatch({ using: [CORE], methodCalls: [echo("a"), echo("b"), echo("c")] }, tiny),
    ).rejects.toThrow();
  });

  it("carries createdIds in from the envelope", async () => {
    const out = await dispatch(
      { using: [CORE], methodCalls: [echo("a")], createdIds: { tmp: "real-id" } },
      ctx,
    );
    expect(out.createdIds).toEqual({ tmp: "real-id" });
  });
});
