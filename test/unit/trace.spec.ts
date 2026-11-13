import { expect, it } from "vitest";
import { describeArgs, describeTrace, newTrace } from "../../src/jmap/trace.js";
import { dispatch } from "../../src/jmap/router.js";
import { currentTrace } from "../../src/jmap/trace.js";

it("describes a call by its filter and window, never by what the user typed", () => {
  const shape = describeArgs({
    accountId: "g_1",
    filter: {
      operator: "AND",
      conditions: [
        { inMailbox: "l_INBOX" },
        { hasKeyword: "$seen" },
        { text: "segreto di stato" },
        { from: "a@b.example" },
        { inMailboxOtherThan: ["l_TRASH", "l_SPAM"] },
      ],
    },
    sort: [{ property: "receivedAt", isAscending: false }],
    limit: 50,
    position: 0,
    calculateTotal: true,
    ids: ["m_1", "m_2", "m_3"],
    properties: ["id", "subject"],
  });
  expect(shape).toEqual({
    filter: {
      operator: "AND",
      conditions: [
        { inMailbox: "l_INBOX" },
        { hasKeyword: "$seen" },
        { text: "<string 18>" },
        { from: "<string 13>" },
        { inMailboxOtherThan: ["l_TRASH", "l_SPAM"] },
      ],
    },
    sort: [{ property: "receivedAt", isAscending: false }],
    limit: 50,
    position: 0,
    calculateTotal: true,
    ids: 3,
    properties: ["id", "subject"],
  });
});

it("shows only the filter keys known to be safe, whatever the method", () => {
  // What the webmail sends to ContactCard/query, and keys nobody listed.
  const logged = JSON.stringify(
    describeArgs({
      filter: {
        uid: "urn:uuid:5f0c1a2e-secret",
        email: "someone@example.com",
        phone: "+39 333 1234567",
        inMailbox: { nested: "l_SECRET" },
        operator: "OR",
        conditions: [{ anything: { deep: "private" } }, "bare-secret"],
      },
    }),
  );
  for (const secret of ["5f0c1a2e", "someone@", "333", "l_SECRET", "private", "bare-secret"])
    expect(logged).not.toContain(secret);
  expect(JSON.parse(logged).filter).toMatchObject({ operator: "OR", uid: "<string 26>" });
});

it("books upstream work to the call it was done for", async () => {
  const seen: Record<number, number[]> = {};
  await dispatch(
    {
      using: ["urn:ietf:params:jmap:core"],
      methodCalls: [
        ["Core/echo", { n: 1 }, "a"],
        ["Core/echo", { n: 2 }, "b"],
      ],
    },
    {
      methods: {
        "Core/echo": async (args) => {
          const n = args.n as number;
          const trace = currentTrace()!;
          seen[n] = [trace.calls];
          trace.calls += n * 10;
          await new Promise((resolve) => setTimeout(resolve, 1));
          seen[n]!.push(currentTrace()!.calls);
          return args;
        },
      },
      maxCallsInRequest: 8,
      sessionState: "s",
    } as any,
  );
  // Each call starts from an empty trace and keeps its own across awaits.
  expect(seen).toEqual({ 1: [0, 10], 2: [0, 20] });
  expect(describeTrace(newTrace())).toBeUndefined();
});
