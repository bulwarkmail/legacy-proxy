import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GMAIL_READONLY,
  parseOAuthClients,
  redirectAllowed,
  type GmailConfig,
} from "../../src/gmail/config.js";
import { GmailStore } from "../../src/gmail/store.js";
import { GmailConnection, type GoogleClient } from "../../src/gmail/connection.js";
import { registerGmailRoutes } from "../../src/gmail/routes.js";

const REDIRECT = "https://mail.example.com/*/auth/callback";
const config: GmailConfig = {
  clientId: "test-client",
  clientSecret: "test-secret",
  origin: "https://bridge.example.com",
  redirectUri: "https://bridge.example.com/auth/google/callback",
  secureCookies: true,
  allowedEmails: new Set(["test@gmail.com"]),
  oauthClients: [{ id: "webmail", redirectUris: [REDIRECT] }],
};
const dirs: string[] = [];
const stores: GmailStore[] = [];
const key = crypto.randomBytes(32);
function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmail-signin-"));
  dirs.push(dir);
  const store = new GmailStore(dir, key);
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeGoogle(tokens: Record<string, unknown>, email = "test@gmail.com") {
  const client: GoogleClient = {
    credentials: {},
    generateCodeVerifierAsync: vi.fn(async () => ({ codeVerifier: "verifier", codeChallenge: "challenge" })),
    generateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/v2/auth"),
    getToken: vi.fn(async () => ({ tokens })),
    setCredentials: vi.fn((c) => {
      client.credentials = c;
    }),
    getAccessToken: vi.fn(async () => {}),
    request: vi.fn(async (options) => ({
      data: options.url.endsWith("/profile")
        ? { emailAddress: email, historyId: "1", messagesTotal: 0, threadsTotal: 0 }
        : { labels: [] },
    })) as GoogleClient["request"],
  };
  return client;
}
const WITH_GRANT = { access_token: "A", refresh_token: "R", expiry_date: 1, scope: GMAIL_READONLY };
const WITHOUT_GRANT = { access_token: "A2", expiry_date: 1, scope: GMAIL_READONLY };

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

async function setup(signIn: { email: string; needsConsent: boolean }[] = [{ email: "test@gmail.com", needsConsent: false }]) {
  const app = Fastify();
  const store = database();
  // A connected account, so tokens can be issued for it.
  await new GmailConnection(config, store, () => fakeGoogle(WITH_GRANT)).connect("c", "v");
  const connection = {
    authorization: vi.fn(async (state: string, _options?: unknown) => ({
      url: `https://accounts.google.com/o/oauth2/v2/auth?state=${state}`,
      verifier: "google-verifier",
    })),
    connect: vi.fn(async () => "test@gmail.com"),
    signIn: vi.fn(async () => signIn.shift() ?? { email: "test@gmail.com", needsConsent: false }),
  };
  await registerGmailRoutes(app, { config, connection, tokens: store });
  const { verifier, challenge } = pkce();
  const redirectUri = "https://mail.example.com/it/auth/callback";
  const authorize = (extra: Record<string, string> = {}) =>
    app.inject(
      "/oauth/authorize?" +
        new URLSearchParams({
          response_type: "code",
          client_id: "webmail",
          redirect_uri: redirectUri,
          state: "app-state",
          code_challenge: challenge,
          code_challenge_method: "S256",
          ...extra,
        }),
    );
  /** Follows one Google round trip: the bridge's redirect to Google, then Google's callback. */
  const google = async (response: Awaited<ReturnType<typeof authorize>>) => {
    expect(response.statusCode).toBe(303);
    const state = new URL(String(response.headers.location)).searchParams.get("state");
    const cookie = String(response.headers["set-cookie"]).split(";")[0]!;
    return app.inject({ url: `/auth/google/callback?state=${state}&code=google-code`, headers: { cookie } });
  };
  const token = (form: Record<string, string>) =>
    app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams(form).toString(),
    });
  const codeFrom = (response: { headers: Record<string, unknown> }) => {
    const url = new URL(String(response.headers.location));
    expect(url.origin + url.pathname).toBe(redirectUri);
    return url;
  };
  return { app, store, connection, verifier, redirectUri, authorize, google, token, codeFrom };
}

describe("OAuth client registration", () => {
  it("parses registered clients and matches a locale segment, nothing wider", () => {
    const [client] = parseOAuthClients(JSON.stringify([{ id: "webmail", redirectUris: [REDIRECT] }]));
    expect(redirectAllowed(client!, "https://mail.example.com/it/auth/callback")).toBe(true);
    expect(redirectAllowed(client!, "https://mail.example.com/a/b/auth/callback")).toBe(false);
    expect(redirectAllowed(client!, "https://mail.example.com.evil.test/it/auth/callback")).toBe(false);
    expect(redirectAllowed(client!, "https://mail.example.com/it/auth/callback?x=1")).toBe(false);
    expect(parseOAuthClients(undefined)).toEqual([]);
    expect(() => parseOAuthClients('[{"id":"x","redirectUris":["http://mail.example.com/cb"]}]')).toThrow();
    expect(() => parseOAuthClients('[{"id":"x","redirectUris":[]}]')).toThrow();
  });
});

describe("sign-in for registered applications", () => {
  it("publishes its metadata only when applications are registered", async () => {
    const { app } = await setup();
    const metadata = (await app.inject("/.well-known/oauth-authorization-server")).json();
    expect(metadata).toMatchObject({
      issuer: config.origin,
      authorization_endpoint: `${config.origin}/oauth/authorize`,
      token_endpoint: `${config.origin}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });
    const bare = Fastify();
    await registerGmailRoutes(bare, {
      config: { ...config, oauthClients: [] },
      connection: { authorization: vi.fn(), connect: vi.fn() },
    });
    expect((await bare.inject("/.well-known/oauth-authorization-server")).statusCode).toBe(404);
    expect((await bare.inject("/oauth/authorize")).statusCode).toBe(404);
  });

  it("never redirects to an unregistered address and insists on PKCE", async () => {
    const { authorize } = await setup();
    const stranger = await authorize({ redirect_uri: "https://evil.test/it/auth/callback" });
    expect(stranger.statusCode).toBe(400);
    expect(stranger.headers.location).toBeUndefined();
    const plain = await authorize({ code_challenge_method: "plain" });
    const url = new URL(String(plain.headers.location));
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("state")).toBe("app-state");
  });

  it("signs in with Google and hands out bridge tokens that open the mailbox", async () => {
    const { store, connection, verifier, redirectUri, authorize, google, token, codeFrom } = await setup();
    const back = codeFrom(await google(await authorize()));
    expect(connection.authorization).toHaveBeenCalledWith(expect.any(String), { prompt: "select_account" });
    expect(back.searchParams.get("state")).toBe("app-state");
    expect(back.searchParams.get("iss")).toBe(config.origin);
    const code = back.searchParams.get("code")!;

    const wrong = await token({ grant_type: "authorization_code", client_id: "webmail", code, redirect_uri: redirectUri, code_verifier: pkce().verifier });
    expect(wrong.json()).toEqual({ error: "invalid_grant" });
    // The failed attempt consumed the code.
    const late = await token({ grant_type: "authorization_code", client_id: "webmail", code, redirect_uri: redirectUri, code_verifier: verifier });
    expect(late.statusCode).toBe(400);

    const again = codeFrom(await google(await authorize())).searchParams.get("code")!;
    const issued = await token({ grant_type: "authorization_code", client_id: "webmail", code: again, redirect_uri: redirectUri, code_verifier: verifier });
    expect(issued.statusCode).toBe(200);
    const body = issued.json();
    expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(body.access_token).toMatch(/^gmat_/);
    expect(body.refresh_token).toMatch(/^gmrt_/);
    expect(store.authenticateToken(body.access_token)).toBe("test@gmail.com");
    // Bridge passwords are a separate credential: a token is not one.
    expect(store.authenticate(body.access_token)).toBeNull();
  });

  it("asks Google for consent once when the account has no grant, then gives up", async () => {
    const { connection, authorize, google, codeFrom } = await setup([
      { email: "test@gmail.com", needsConsent: true },
      { email: "test@gmail.com", needsConsent: true },
    ]);
    const consent = await google(await authorize());
    expect(connection.authorization).toHaveBeenLastCalledWith(expect.any(String), {
      prompt: "consent",
      loginHint: "test@gmail.com",
    });
    const refused = codeFrom(await google(consent));
    expect(refused.searchParams.get("error")).toBe("access_denied");
    expect(refused.searchParams.get("code")).toBeNull();
  });

  it("refreshes for the client it was issued to and stops after revocation", async () => {
    const { app, store, verifier, redirectUri, authorize, google, token, codeFrom } = await setup();
    const code = codeFrom(await google(await authorize())).searchParams.get("code")!;
    const first = (await token({ grant_type: "authorization_code", client_id: "webmail", code, redirect_uri: redirectUri, code_verifier: verifier })).json();

    const refreshed = (await token({ grant_type: "refresh_token", client_id: "webmail", refresh_token: first.refresh_token })).json();
    expect(refreshed.access_token).not.toBe(first.access_token);
    expect(refreshed.refresh_token).toBe(first.refresh_token);
    expect((await token({ grant_type: "refresh_token", client_id: "other", refresh_token: first.refresh_token })).statusCode).toBe(401);

    const revoke = await app.inject({
      method: "POST",
      url: "/oauth/revoke",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ token: first.refresh_token, client_id: "webmail" }).toString(),
    });
    expect(revoke.statusCode).toBe(200);
    expect(store.authenticateToken(refreshed.access_token)).toBeNull();
    expect((await token({ grant_type: "refresh_token", client_id: "webmail", refresh_token: first.refresh_token })).json()).toEqual({ error: "invalid_grant" });
  });
});

describe("sign-in tokens", () => {
  it("expire, and go with the account when it is disconnected", async () => {
    const store = database();
    await new GmailConnection(config, store, () => fakeGoogle(WITH_GRANT)).connect("c", "v");
    const t = store.issueTokens("test@gmail.com", "webmail", 1_000);
    expect(store.authenticateToken(t.accessToken, 1_000 + 3599_000)).toBe("test@gmail.com");
    expect(store.authenticateToken(t.accessToken, 1_000 + 3600_000)).toBeNull();
    expect(store.refreshTokens(t.refreshToken, "webmail", 2_000)).not.toBeNull();
    store.disconnect("test@gmail.com");
    expect(store.refreshTokens(t.refreshToken, "webmail", 3_000)).toBeNull();
    expect(() => store.issueTokens("test@gmail.com", "webmail")).toThrow("not connected");
  });
});

describe("Google sign-in", () => {
  it("only asks which account, and keeps the stored grant when Google sends no refresh token", async () => {
    const store = database();
    await new GmailConnection(config, store, () => fakeGoogle(WITH_GRANT)).connect("c", "v");
    const client = fakeGoogle(WITHOUT_GRANT);
    const service = new GmailConnection(config, store, () => client);
    await service.authorization("s", { prompt: "select_account" });
    expect(client.generateAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "select_account", include_granted_scopes: true }),
    );
    expect(await service.signIn("code", "verifier")).toEqual({ email: "test@gmail.com", needsConsent: false });
    expect((await store.load("test@gmail.com"))?.credentials.refreshToken).toBe("R");
  });

  it("reports that an account without a stored grant needs consent", async () => {
    const store = database();
    const service = new GmailConnection(config, store, () => fakeGoogle(WITHOUT_GRANT));
    expect(await service.signIn("code", "verifier")).toEqual({ email: "test@gmail.com", needsConsent: true });
    expect(await store.load("test@gmail.com")).toBeNull();
  });

  it("stores the grant when Google sends one, and refuses accounts off the allowlist", async () => {
    const store = database();
    expect(await new GmailConnection(config, store, () => fakeGoogle(WITH_GRANT)).signIn("c", "v")).toEqual({
      email: "test@gmail.com",
      needsConsent: false,
    });
    expect(store.hasConnection("test@gmail.com")).toBe(true);
    await expect(
      new GmailConnection(config, database(), () => fakeGoogle(WITHOUT_GRANT, "stranger@gmail.com")).signIn("c", "v"),
    ).rejects.toThrow("not allowed");
  });
});
