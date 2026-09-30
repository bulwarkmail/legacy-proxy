import {
  OAuth2Client,
  CodeChallengeMethod,
  type Credentials as GoogleCredentials,
  type GenerateAuthUrlOpts,
} from "google-auth-library";
import type { Credentials } from "../auth/credentials.js";
import { GMAIL_READONLY, GMAIL_MODIFY, type GmailConfig } from "./config.js";
import { GmailStore, type GmailSnapshot, type GmailProfile, type GmailLabel } from "./store.js";

// A narrow, injectable boundary keeps tests independent of Google and credentials.
export interface GoogleClient {
  generateCodeVerifierAsync(): Promise<{ codeVerifier: string; codeChallenge?: string }>;
  generateAuthUrl(options: GenerateAuthUrlOpts): string;
  getToken(options: {
    code: string;
    codeVerifier: string;
    redirect_uri: string;
  }): Promise<{ tokens: GoogleCredentials }>;
  setCredentials(credentials: GoogleCredentials): void;
  credentials: GoogleCredentials;
  getAccessToken(): Promise<unknown>;
  getTokenInfo?(token: string): Promise<{ scopes: string[] }>;
  request<T>(options: {
    url: string;
    timeout: number;
    retry: boolean;
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    data?: unknown;
    headers?: Record<string, string>;
    /** `text` keeps a multipart batch answer intact instead of letting the transport parse it as JSON. */
    responseType?: "text";
  }): Promise<{ data: T }>;
}
export type GoogleClientFactory = () => GoogleClient;

export class GmailConnection {
  private readonly pending = new Map<string, Promise<GmailSnapshot>>();
  readonly createClient: GoogleClientFactory;
  constructor(
    readonly config: GmailConfig,
    private readonly store: GmailStore,
    factory?: GoogleClientFactory,
  ) {
    this.createClient =
      factory ??
      (() =>
        new OAuth2Client({
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          redirectUri: config.redirectUri,
          transporterOptions: { timeout: 15_000, retry: false },
        }));
  }
  /**
   * The Google consent URL. Connecting asks for consent every time, which is what makes Google hand out a
   * refresh token; signing in only asks which account, and falls back to consent when that account has no
   * working grant yet (see signIn).
   */
  async authorization(
    state: string,
    options: { prompt?: "consent" | "select_account"; loginHint?: string } = {},
  ): Promise<{ url: string; verifier: string }> {
    const client = this.createClient();
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    if (!codeChallenge) throw new Error("PKCE unavailable");
    return {
      verifier: codeVerifier,
      url: client.generateAuthUrl({
        access_type: "offline",
        prompt: options.prompt ?? "consent",
        scope: [this.requiredScope()],
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        redirect_uri: this.config.redirectUri,
        ...(options.prompt === "select_account" ? { include_granted_scopes: true } : {}),
        ...(options.loginHint ? { login_hint: options.loginHint } : {}),
      }),
    };
  }
  private requiredScope(): string {
    return this.config.writeEnabled ? GMAIL_MODIFY : GMAIL_READONLY;
  }
  private async snapshot(client: GoogleClient): Promise<GmailSnapshot> {
    // getProfile proves which Gmail account owns the token. Never trust a form/email hint.
    const { data: profile } = await client.request<GmailProfile>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      timeout: 15_000,
      retry: false,
    });
    if (
      typeof profile.emailAddress !== "string" ||
      !this.config.allowedEmails.has(profile.emailAddress.toLowerCase())
    ) {
      throw new Error("Account is not allowed");
    }
    const { data } = await client.request<{ labels?: GmailLabel[] }>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      timeout: 15_000,
      retry: false,
    });
    return { profile, labels: data.labels ?? [] };
  }
  private credentials(client: GoogleClient, email: string): Credentials {
    const c = client.credentials;
    if (!c.refresh_token) throw new Error("Google did not grant offline access; reconnect with consent");
    return {
      mech: "XOAUTH2",
      username: email,
      accessToken: c.access_token ?? undefined,
      refreshToken: c.refresh_token,
      expiresAt: c.expiry_date ?? undefined,
    };
  }
  private async exchange(code: string, verifier: string) {
    const client = this.createClient();
    const { tokens } = await client.getToken({
      code,
      codeVerifier: verifier,
      redirect_uri: this.config.redirectUri,
    });
    const scopes =
      tokens.scope?.split(" ") ??
      (tokens.access_token && client.getTokenInfo
        ? (await client.getTokenInfo(tokens.access_token)).scopes
        : []);
    const granted = !(this.config.writeEnabled
      ? !scopes.includes(GMAIL_MODIFY)
      : tokens.scope && !scopes.includes(GMAIL_READONLY) && !scopes.includes(GMAIL_MODIFY));
    return { client, tokens, scopes, granted };
  }
  private async save(client: GoogleClient, scopes: string[]): Promise<string> {
    const snapshot = await this.snapshot(client);
    const email = snapshot.profile.emailAddress.toLowerCase();
    // Avoid replacing a working connection with a grant without a refresh token.
    await this.store.save(email, { ...this.credentials(client, email), scopes }, snapshot);
    this.store.invalidate(email);
    return email;
  }
  /** Exchanges the code, stores the grant and returns the connected address. */
  async connect(code: string, verifier: string): Promise<string> {
    const { client, tokens, scopes, granted } = await this.exchange(code, verifier);
    if (!granted) throw new Error("Required permission was not granted");
    client.setCredentials(tokens);
    return this.save(client, scopes);
  }
  /**
   * Exchanges a sign-in code. When Google handed out a refresh token with the required access, the grant is
   * stored as by connect(). Otherwise the code only proves who signed in: that is enough for an account whose
   * grant is already stored, and any other account is reported as needing consent. The stored grant is never
   * replaced by one without offline access.
   */
  async signIn(code: string, verifier: string): Promise<{ email: string; needsConsent: boolean }> {
    const { client, tokens, scopes, granted } = await this.exchange(code, verifier);
    client.setCredentials(tokens);
    if (granted && tokens.refresh_token) return { email: await this.save(client, scopes), needsConsent: false };
    // getProfile proves the account and applies the allowlist, as for a connection.
    const { data: profile } = await client.request<GmailProfile>({
      url: "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      timeout: 15_000,
      retry: false,
    });
    const email = typeof profile.emailAddress === "string" ? profile.emailAddress.toLowerCase() : "";
    if (!email || !this.config.allowedEmails.has(email)) throw new Error("Account is not allowed");
    const saved = granted && (await this.store.load(email));
    // Grants stored before scopes were recorded carry none: they were checked when stored.
    const savedScopes = saved ? saved.credentials.scopes : undefined;
    const stillGranted =
      !!saved &&
      !!saved.credentials.refreshToken &&
      (!savedScopes ||
        savedScopes.includes(GMAIL_MODIFY) ||
        (!this.config.writeEnabled && savedScopes.includes(GMAIL_READONLY)));
    return { email, needsConsent: !stillGranted };
  }
  /** Refreshes expired access tokens and persists their replacements across restarts. */
  refreshSnapshot(email: string): Promise<GmailSnapshot> {
    email = email.toLowerCase();
    const existing = this.pending.get(email);
    if (existing) return existing;
    const task = this.refresh(email).finally(() => {
      this.pending.delete(email);
    });
    this.pending.set(email, task);
    return task;
  }
  private async refresh(email: string): Promise<GmailSnapshot> {
    if (!this.config.allowedEmails.has(email)) throw new Error("Account is not allowed");
    const saved = await this.store.load(email);
    if (!saved) throw new Error("Account is not connected");
    const client = this.createClient();
    client.setCredentials({
      access_token: saved.credentials.accessToken,
      refresh_token: saved.credentials.refreshToken,
      expiry_date: saved.credentials.expiresAt,
    });
    await client.getAccessToken();
    const snapshot = await this.snapshot(client);
    if (snapshot.profile.emailAddress.toLowerCase() !== email) throw new Error("Account mismatch");
    await this.store.updateCredentials(
      email,
      { ...this.credentials(client, email), scopes: saved.credentials.scopes },
      saved.credentials.refreshToken,
      snapshot,
    );
    return snapshot;
  }
  /** Revokes the Google grant (best effort) and deletes everything stored for the account. True when Google confirmed. */
  async disconnect(email: string): Promise<boolean> {
    email = email.toLowerCase();
    const saved = await this.store.load(email);
    const token = saved?.credentials.refreshToken ?? saved?.credentials.accessToken;
    let revoked = false;
    if (token) {
      const client = this.createClient() as GoogleClient & {
        revokeToken?: (token: string) => Promise<unknown>;
      };
      try {
        if (client.revokeToken) {
          await client.revokeToken(token);
          revoked = true;
        }
      } catch {
        // Already revoked or Google unreachable: the local data is deleted either way.
      }
    }
    this.store.disconnect(email);
    return revoked;
  }
}
