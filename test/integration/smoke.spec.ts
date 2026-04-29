// Integration smoke test - requires `compose.test.yml` to be up.
// Skipped by default; run with `npm run test:integration` after `docker compose
// -f compose.test.yml up -d`.

import { describe, expect, it } from "vitest";

const PROXY = process.env.PROXY_URL ?? "http://localhost:8080";
const SHOULD_RUN = process.env.RUN_INTEGRATION === "1";

(SHOULD_RUN ? describe : describe.skip)("legacy-proxy integration", () => {
  it("serves a JMAP session for a logged-in user", async () => {
    const login = await fetch(`${PROXY}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: process.env.TEST_USER ?? "test@local",
        password: process.env.TEST_PASS ?? "test",
        provider: process.env.TEST_PROVIDER ?? "stalwart-test",
      }),
    });
    expect(login.ok).toBe(true);
    const { token } = (await login.json()) as { token: string };

    const sess = await fetch(`${PROXY}/jmap/session`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(sess.ok).toBe(true);
    const body = (await sess.json()) as { capabilities: Record<string, unknown> };
    expect(body.capabilities["urn:ietf:params:jmap:core"]).toBeTruthy();
    expect(body.capabilities["urn:ietf:params:jmap:mail"]).toBeTruthy();
    expect(body.capabilities["urn:ietf:params:jmap:submission"]).toBeTruthy();
    expect(body.capabilities["urn:ietf:params:jmap:vacationresponse"]).toBeTruthy();
  });
});
