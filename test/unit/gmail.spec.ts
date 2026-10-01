import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GMAIL_READONLY, GMAIL_MODIFY, loadGmailConfig, type GmailConfig } from "../../src/gmail/config.js";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailConnection, type GoogleClient } from "../../src/gmail/connection.js";
import { registerGmailRoutes } from "../../src/gmail/routes.js";

const config: GmailConfig = {
  clientId: "test-client",
  clientSecret: "test-secret",
  origin: "https://bridge.example.com",
  redirectUri: "https://bridge.example.com/auth/google/callback",
  secureCookies: true,
  allowedEmails: new Set(["test@gmail.com"]),
};
const dirs: string[] = [];
const stores: GmailStore[] = [];
const key = crypto.randomBytes(32);
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-test-"));
  dirs.push(dir);
  return dir;
}
function database(dir = directory()) {
  const store = new GmailStore(dir, key);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
function fakeGoogle(email = "test@gmail.com") {
  const client: GoogleClient = {
    credentials: {},
    generateCodeVerifierAsync: vi.fn(async () => ({ codeVerifier: "verifier", codeChallenge: "challenge" })),
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth"),
    getToken: vi.fn(async () => ({
      tokens: {
        access_token: "ACCESS-SECRET",
        refresh_token: "REFRESH-SECRET",
        expiry_date: 1,
        scope: GMAIL_READONLY,
      },
    })),
    setCredentials: vi.fn((c) => {
      client.credentials = c;
    }),
    getAccessToken: vi.fn(async () => {
      client.credentials = {
        ...client.credentials,
        access_token: "REFRESHED-SECRET",
        expiry_date: Date.now() + 3600_000,
      };
    }),
    request: vi.fn(async (options) => ({
      data: options.url.endsWith("/profile")
        ? { emailAddress: email, historyId: "12345678901234567890", messagesTotal: 2, threadsTotal: 1 }
        : { labels: [{ id: "INBOX", name: "INBOX", type: "system" }] },
    })) as GoogleClient["request"],
  };
  return client;
}

describe("Gmail connection", () => {
  it("requests only read access with offline consent and PKCE", async () => {
    const client = fakeGoogle();
    await new GmailConnection(config, database(), () => client).authorization("browser-state");
    expect(client.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: [GMAIL_READONLY],
        state: "browser-state",
        access_type: "offline",
        prompt: "consent",
        code_challenge: "challenge",
        code_challenge_method: "S256",
        redirect_uri: config.redirectUri,
      }),
    );
  });
  it("persists encrypted credentials and an exact history ID across restarts", async () => {
    const dir = directory();
    const store = database(dir);
    const client = fakeGoogle();
    await new GmailConnection(config, store, () => client).connect("authorization-code", "verifier");
    expect(client.getToken).toHaveBeenCalledWith({
      code: "authorization-code",
      codeVerifier: "verifier",
      redirect_uri: config.redirectUri,
    });
    stores.splice(stores.indexOf(store), 1);
    store.close();
    const bytes = fs.readFileSync(path.join(dir, "gmail.sqlite3"));
    expect(bytes.includes(Buffer.from("REFRESH-SECRET"))).toBe(false);
    expect(bytes.includes(Buffer.from("ACCESS-SECRET"))).toBe(false);
    const saved = await database(dir).load("test@gmail.com");
    expect(saved?.credentials.refreshToken).toBe("REFRESH-SECRET");
    expect(saved?.snapshot.profile.historyId).toBe("12345678901234567890");
    // NTFS has no POSIX permission bits; Node reports 0o666 there.
    if (process.platform !== "win32")
      expect(fs.statSync(path.join(dir, "gmail.sqlite3")).mode & 0o777).toBe(0o600);
  });
  it("rejects a different Google account before fetching labels or saving tokens", async () => {
    const store = database();
    const client = fakeGoogle("stranger@gmail.com");
    await expect(
      new GmailConnection(config, store, () => client).connect("code", "verifier"),
    ).rejects.toThrow("not allowed");
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(await store.load("stranger@gmail.com")).toBeNull();
  });
  it("does not overwrite a working connection when Google omits offline access", async () => {
    const store = database();
    const client = fakeGoogle();
    const service = new GmailConnection(config, store, () => client);
    await service.connect("code", "verifier");
    vi.mocked(client.getToken).mockResolvedValue({
      tokens: { access_token: "incomplete", scope: GMAIL_READONLY },
    });
    await expect(service.connect("code-2", "verifier")).rejects.toThrow("offline access");
    expect((await store.load("test@gmail.com"))?.credentials.accessToken).toBe("ACCESS-SECRET");
  });
  it("rejects partial consent without reading mailbox metadata", async () => {
    const client = fakeGoogle();
    vi.mocked(client.getToken).mockResolvedValue({ tokens: { scope: "openid", access_token: "partial" } });
    await expect(
      new GmailConnection(config, database(), () => client).connect("code", "verifier"),
    ).rejects.toThrow("permission");
    expect(client.request).not.toHaveBeenCalled();
  });
  it("coalesces concurrent refreshes and persists new access tokens", async () => {
    const store = database();
    const client = fakeGoogle();
    const service = new GmailConnection(config, store, () => client);
    await service.connect("code", "verifier");
    const results = await Promise.all([
      service.refreshSnapshot("test@gmail.com"),
      service.refreshSnapshot("test@gmail.com"),
    ]);
    expect(client.getAccessToken).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]);
    expect((await store.load("test@gmail.com"))?.credentials.accessToken).toBe("REFRESHED-SECRET");
    expect((await store.load("test@gmail.com"))?.credentials.refreshToken).toBe("REFRESH-SECRET");
  });
  it("retains the last snapshot on token revocation and allows a later reconnect", async () => {
    const store = database();
    const client = fakeGoogle();
    const service = new GmailConnection(config, store, () => client);
    await service.connect("code", "verifier");
    vi.mocked(client.getAccessToken).mockRejectedValueOnce(new Error("invalid_grant"));
    await expect(service.refreshSnapshot("test@gmail.com")).rejects.toThrow("invalid_grant");
    expect((await store.load("test@gmail.com"))?.snapshot.labels).toHaveLength(1);
    await service.connect("new-code", "verifier");
    await expect(service.refreshSnapshot("test@gmail.com")).resolves.toBeDefined();
  });
});

describe("OAuth routes", () => {
  async function setup() {
    let logs = "";
    let now = 1000;
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk;
        callback();
      },
    });
    const app = Fastify({ logger: { stream } });
    const connection = {
      authorization: vi.fn(async (state: string) => ({
        url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        verifier: "verifier",
      })),
      connect: vi.fn(async () => {}),
    };
    await registerGmailRoutes(app, { config, connection, now: () => now });
    const start = async () => {
      const response = await app.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin: config.origin, "content-type": "application/x-www-form-urlencoded" },
        payload: "",
      });
      expect(response.statusCode).toBe(303);
      return {
        state: new URL(String(response.headers.location)).searchParams.get("state"),
        cookie: String(response.headers["set-cookie"]).split(";")[0]!,
      };
    };
    return {
      app,
      connection,
      start,
      logs: () => logs,
      expire: () => {
        now += 600_001;
      },
    };
  }
  it("requires a same-origin POST to start a flow", async () => {
    const { app, connection } = await setup();
    try {
      const page = await app.inject("/auth/google/start");
      expect(page.statusCode).toBe(200);
      expect(page.headers["referrer-policy"]).toBe("same-origin");
      expect(
        (await app.inject({ method: "POST", url: "/auth/google/start", headers: { origin: "null" } }))
          .statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/auth/google/start",
            headers: { origin: "https://evil.example" },
          })
        ).statusCode,
      ).toBe(403);
      expect(connection.authorization).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("binds callback to its browser, consumes state once, and never logs authorization codes", async () => {
    const { app, connection, start, logs } = await setup();
    try {
      const flow = await start();
      const url = `/auth/google/callback?state=${flow.state}&code=DO-NOT-LOG-AUTH-CODE`;
      expect((await app.inject(url)).statusCode).toBe(400);
      const response = await app.inject({ url, headers: { cookie: flow.cookie } });
      expect(response.headers.location).toBe("/auth/google/result?status=connected");
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["set-cookie"]).toContain("Secure");
      expect((await app.inject({ url, headers: { cookie: flow.cookie } })).statusCode).toBe(400);
      expect(connection.connect).toHaveBeenCalledTimes(1);
      expect(logs()).not.toContain("DO-NOT-LOG-AUTH-CODE");
    } finally {
      await app.close();
    }
  });
  it("expires state before contacting Google", async () => {
    const { app, connection, start, expire } = await setup();
    try {
      const flow = await start();
      expire();
      expect(
        (
          await app.inject({
            url: `/auth/google/callback?state=${flow.state}&code=code`,
            headers: { cookie: flow.cookie },
          })
        ).statusCode,
      ).toBe(400);
      expect(connection.connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("handles denied consent without exchanging a code", async () => {
    const { app, connection, start } = await setup();
    try {
      const flow = await start();
      const response = await app.inject({
        url: `/auth/google/callback?state=${flow.state}&error=access_denied`,
        headers: { cookie: flow.cookie },
      });
      expect(response.headers.location).toBe("/auth/google/result?status=cancelled");
      expect(connection.connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("does not disclose Google errors containing secrets", async () => {
    const { app, connection, start, logs } = await setup();
    try {
      connection.connect.mockRejectedValueOnce(new Error("client_secret=DO-NOT-LOG-SECRET"));
      const flow = await start();
      const response = await app.inject({
        url: `/auth/google/callback?state=${flow.state}&code=code`,
        headers: { cookie: flow.cookie },
      });
      expect(response.headers.location).toBe("/auth/google/result?status=failed");
      expect(response.body + logs()).not.toContain("DO-NOT-LOG-SECRET");
    } finally {
      await app.close();
    }
  });
});

describe("Gmail opt-in config", () => {
  it("is disabled without credentials and requires an allowlist when enabled", () => {
    vi.stubEnv("GMAIL_OAUTH_CLIENT_FILE", "");
    expect(loadGmailConfig(config.origin)).toBeNull();
    const file = path.join(directory(), "oauth.json");
    fs.writeFileSync(file, JSON.stringify({ web: { client_id: "id", client_secret: "secret" } }));
    vi.stubEnv("GMAIL_OAUTH_CLIENT_FILE", file);
    vi.stubEnv("GMAIL_ALLOWED_EMAILS", "");
    expect(() => loadGmailConfig(config.origin)).toThrow("GMAIL_ALLOWED_EMAILS");
    vi.stubEnv("GMAIL_ALLOWED_EMAILS", " TEST@gmail.com ");
    expect(loadGmailConfig(config.origin)?.allowedEmails.has("test@gmail.com")).toBe(true);
    expect(() => loadGmailConfig("http://public.example")).toThrow("HTTPS");
    expect(loadGmailConfig("http://localhost:8080")?.secureCookies).toBe(false);
  });
});

it("requests modify consent only when enabled and preserves it through refresh", async () => {
  const store = database();
  const client = fakeGoogle();
  const configWrite = { ...config, writeEnabled: true };
  vi.mocked(client.getToken).mockResolvedValue({
    tokens: { access_token: "new", refresh_token: "refresh", scope: GMAIL_MODIFY },
  });
  const connection = new GmailConnection(configWrite, store, () => client);
  await connection.authorization("state");
  expect(client.generateAuthUrl).toHaveBeenCalledWith(expect.objectContaining({ scope: [GMAIL_MODIFY] }));
  await connection.connect("code", "verifier");
  expect((await store.load("test@gmail.com"))!.credentials.scopes).toEqual([GMAIL_MODIFY]);
  const password = store.issuePassword("test@gmail.com");
  await connection.refreshSnapshot("test@gmail.com");
  expect((await store.load("test@gmail.com"))!.credentials.scopes).toEqual([GMAIL_MODIFY]);
  expect(store.authenticate(password)).toBe("test@gmail.com");
});
it("refuses incomplete modify consent without overwriting the working grant", async () => {
  const store = database();
  const client = fakeGoogle();
  await new GmailConnection(config, store, () => client).connect("code", "verifier");
  const before = await store.load("test@gmail.com");
  await expect(
    new GmailConnection({ ...config, writeEnabled: true }, store, () => client).connect("code", "verifier"),
  ).rejects.toThrow("permission");
  expect(await store.load("test@gmail.com")).toEqual(before);
});
it("verifies missing scope metadata before enabling modifications", async () => {
  const store = database();
  const client = fakeGoogle();
  vi.mocked(client.getToken).mockResolvedValue({ tokens: { access_token: "new", refresh_token: "refresh" } });
  const connection = new GmailConnection({ ...config, writeEnabled: true }, store, () => client);
  await expect(connection.connect("code", "verifier")).rejects.toThrow("permission");
  client.getTokenInfo = vi.fn(async () => ({ scopes: [GMAIL_MODIFY] }));
  await connection.connect("code", "verifier");
  expect(client.getTokenInfo).toHaveBeenCalledWith("new");
  expect((await store.load("test@gmail.com"))!.credentials.scopes).toEqual([GMAIL_MODIFY]);
});

describe("self-service bridge password", () => {
  it("issues and shows the bridge password exactly once after consent, only when requested", async () => {
    const app = Fastify();
    const issued: string[] = [];
    const store = {
      issuePassword: vi.fn((email: string) => {
        const p = "gmap_" + email.length + "_" + issued.length;
        issued.push(p);
        return p;
      }),
    };
    const connection = {
      authorization: vi.fn(async (state: string) => ({
        url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        verifier: "v",
      })),
      connect: vi.fn(async () => "tester@gmail.com"),
    };
    await registerGmailRoutes(app, { config, connection, store });
    try {
      const form = (await app.inject("/auth/google/start")).body;
      expect(form).toContain('name="issue"');
      const run = async (payload: string) => {
        const start = await app.inject({
          method: "POST",
          url: "/auth/google/start",
          headers: { origin: config.origin, "content-type": "application/x-www-form-urlencoded" },
          payload,
        });
        const state = new URL(String(start.headers.location)).searchParams.get("state");
        const cookie = String(start.headers["set-cookie"]).split(";")[0]!;
        const cb = await app.inject({
          method: "GET",
          url: `/auth/google/callback?state=${state}&code=abc`,
          headers: { cookie },
        });
        expect(cb.statusCode).toBe(303);
        const cookies = ([] as string[])
          .concat(cb.headers["set-cookie"] as string | string[])
          .map((c) => c.split(";")[0]!);
        const resultCookie = cookies.find(
          (c) => c.startsWith("gmail_result=") && c.length > "gmail_result=".length,
        );
        const result = await app.inject({
          method: "GET",
          url: "/auth/google/result?status=connected",
          headers: resultCookie ? { cookie: resultCookie } : {},
        });
        return { result, resultCookie };
      };
      const without = await run("");
      expect(store.issuePassword).not.toHaveBeenCalled();
      expect(without.resultCookie).toBeUndefined();
      expect(without.result.body).toContain("existing bridge password still works");
      const with_ = await run("issue=1");
      expect(store.issuePassword).toHaveBeenCalledWith("tester@gmail.com");
      expect(with_.result.body).toContain(issued[0]);
      expect(with_.result.body).toContain("tester@gmail.com");
      expect(with_.result.body).toContain(config.origin);
      // Second view with the same cookie: the secret is gone.
      const again = await app.inject({
        method: "GET",
        url: "/auth/google/result?status=connected",
        headers: { cookie: with_.resultCookie! },
      });
      expect(again.body).not.toContain(issued[0]);
    } finally {
      await app.close();
    }
  });
  it("issues a first password automatically and never claims a rotated password still works", async () => {
    const app = Fastify();
    let has = false;
    const store = {
      issuePassword: vi.fn(() => {
        has = true;
        return "gmap_first";
      }),
      hasPassword: vi.fn(() => has),
    };
    const connection = {
      authorization: vi.fn(async (state: string) => ({
        url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        verifier: "v",
      })),
      connect: vi.fn(async () => "tester@gmail.com"),
    };
    await registerGmailRoutes(app, { config, connection, store });
    const run = async (payload: string) => {
      const start = await app.inject({
        method: "POST",
        url: "/auth/google/start",
        headers: { origin: config.origin, "content-type": "application/x-www-form-urlencoded" },
        payload,
      });
      const state = new URL(String(start.headers.location)).searchParams.get("state");
      const cookie = String(start.headers["set-cookie"]).split(";")[0]!;
      return app.inject({ url: `/auth/google/callback?state=${state}&code=abc`, headers: { cookie } });
    };
    try {
      expect((await app.inject("/auth/google/start")).body).not.toContain("checked");
      expect((await run("")).headers.location).toBe("/auth/google/result?status=issued");
      expect(store.issuePassword).toHaveBeenCalledTimes(1);
      expect((await run("")).headers.location).toBe("/auth/google/result?status=connected");
      expect(store.issuePassword).toHaveBeenCalledTimes(1);
      const reload = await app.inject("/auth/google/result?status=issued");
      expect(reload.body).not.toContain("still works");
      expect(reload.body).toContain("no longer works");
    } finally {
      await app.close();
    }
  });
  it("keeps no server-side state for flows that are started but never finished", async () => {
    const app = Fastify();
    const connection = {
      authorization: vi.fn(async (state: string) => ({
        url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
        verifier: "v",
      })),
      connect: vi.fn(async () => {}),
    };
    await registerGmailRoutes(app, { config, connection });
    try {
      for (let i = 0; i < 150; i++) {
        const started = await app.inject({
          method: "POST",
          url: "/auth/google/start",
          headers: { origin: config.origin },
        });
        expect(started.statusCode).toBe(303);
      }
      const forged = await app.inject({
        url: "/auth/google/callback?state=x&code=c",
        headers: { cookie: "gmail_oauth=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      });
      expect(forged.statusCode).toBe(400);
      expect(connection.connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe("allowlist", () => {
  it("accepts exact addresses and whole @domains, case-insensitively", async () => {
    const { AllowList } = await import("../../src/gmail/config.js");
    const list = new AllowList([" One@Example.test ", "@Corp.example", "", "@", "bad", "@x@y"]);
    expect(list.size).toBe(2);
    for (const ok of ["one@example.test", "ONE@example.test", "anyone@corp.example", "Other@CORP.example"])
      expect(list.has(ok)).toBe(true);
    for (const no of ["two@example.test", "anyone@notcorp.example", "corp.example", "@corp.example", "x@y"])
      expect(list.has(no)).toBe(false);
  });
});
