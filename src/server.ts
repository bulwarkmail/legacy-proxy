import crypto from "node:crypto";
import { Transform, pipeline, type Readable } from "node:stream";
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import { loadConfig, type ProviderConfig } from "./util/config.js";
import { log } from "./util/log.js";
import { corsOptions, fromBrowser } from "./util/cors.js";
import { Store } from "./state/store.js";
import { ImapPool } from "./imap/pool.js";
import { resolveProvider, resolveProviderName } from "./auth/providers.js";
import { sealCredentials, openCredentials, type Credentials } from "./auth/credentials.js";
import {
  credentialTag,
  generationValid,
  makeSession,
  sessionGeneration,
  signSession,
  verifySession,
  type SessionToken,
} from "./auth/session.js";
import { buildSession } from "./jmap/session.js";
import { KNOWN_CAPABILITIES } from "./jmap/capabilities.js";
import { dispatch, isRequestEnvelope, NOT_REQUEST_PROBLEM } from "./jmap/router.js";
import { makeLegacyMethods } from "./backends/legacy.js";
import { EventSourceHub } from "./jmap/eventsource.js";
import { imapErrorDetails, isCredentialRefusal, openImap } from "./imap/client.js";
import { LoginLimiter } from "./auth/loginLimit.js";
import { PushDispatcher } from "./push/dispatcher.js";
import { PushIdleManager } from "./push/idle.js";

import { loadGmailConfig } from "./gmail/config.js";
import { GmailStore } from "./gmail/store.js";
import { GmailConnection } from "./gmail/connection.js";
import { isBridgeSecret, registerGmailBackend } from "./gmail/backend.js";
import { registerGmailRoutes } from "./gmail/routes.js";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const pool = new ImapPool(cfg, store);
const hub = new EventSourceHub();
const dispatcher = new PushDispatcher(store, hub, (id) => store.getAccountById(id));
const idleManager = new PushIdleManager(cfg, store);

// Hook the store so every counter bump (Email/set, Mailbox/set, IDLE arrival,
// EmailSubmission/set...) feeds the same fan-out path. The dispatcher
// debounces internally so a Email/set that bumps both `email` and `mailbox`
// in quick succession only produces one StateChange to each subscriber.
store.setStateListener((accountId, kind, state) => dispatcher.onBump(accountId, kind, state));

// The dispatcher tells the idle manager when the verified-subscription set
// changed so it can spin up or tear down INBOX IDLE workers without needing
// to sweep the DB on every JMAP call.
dispatcher.setHooks({ onSubscriberChange: idleManager.onSubscriberChange });

// When an account's credential generation moves, nothing logged in with the
// old credentials keeps serving it: pooled connections close and the IDLE
// worker starts over. Cached Basic logins check the generation themselves.
store.setCredentialListener((accountId) => {
  pool.retire(accountId);
  idleManager.onCredentialsChanged(accountId);
});

// Spin up idle workers for any verified subscription that survived a previous
// run. Failure here is non-fatal (the next reconnect will try again), so we
// don't await — the server should come up even if a single account's IMAP is
// temporarily unreachable.
void idleManager.sync().catch((err) =>
  log.warn({ err: (err as Error).message }, "idle: initial sync failed"),
);

const app = Fastify({
  loggerInstance: log,
  bodyLimit: cfg.limits.maxSizeRequest,
  disableRequestLogging: false,
  // Behind a reverse proxy the socket address is the proxy's; TRUST_PROXY lets
  // `req.ip` be the client's, which the login limits count by.
  trustProxy: cfg.trustProxy,
  // The download URL carries the attachment's file name as a path segment.
  // Fastify's default cap of 100 characters answers longer ones with a 404,
  // which a client shows as an empty attached message; percent-encoding
  // triples non-ASCII names, so leave room for a 255-byte name.
  routerOptions: { maxParamLength: 1024 },
});

await app.register(cors, corsOptions);
// JMAP responses with bodyValues are large, highly compressible JSON —
// hundreds of KB shrink to tens. The SSE route is unaffected: it writes to
// reply.raw directly, bypassing the onSend hook this plugin uses.
await app.register(compress, { global: true, threshold: 1024 });

// Failed logins by callers without a session are counted before anything
// reaches the mail server (see auth/loginLimit.ts).
const logins = new LoginLimiter();

const gmailConfig = loadGmailConfig(cfg.publicUrl);
const gmailStore = gmailConfig ? new GmailStore(cfg.dataDir, cfg.vaultKey) : null;
// Operational counters only (no addresses, subjects or bodies): pending/uncertain sends are the ones to watch.
const gmailHooks: { push?: import("./gmail/push.js").GmailPush } = {};
app.get("/healthz", async () => ({ ok: true, ...(gmailStore && gmailConfig?.schedule ? { gmailSchedule: gmailStore.scheduleStats() } : {}), ...(gmailHooks.push ? { gmailPush: gmailHooks.push.stats() } : {}) }));

if (gmailConfig && gmailStore) {
  const connection = new GmailConnection(gmailConfig, gmailStore);
  registerGmailBackend(app, cfg, gmailConfig, gmailStore, connection, gmailHooks, undefined, logins);
  await app.register(registerGmailRoutes, { config: gmailConfig, connection, store: gmailStore, tokens: gmailStore });
  app.addHook("onClose", async () => gmailStore.close());
}

function sendLimited(reply: import("fastify").FastifyReply, gate: { status: 429 | 503; retryAfterSec: number }) {
  reply.header("Retry-After", String(gate.retryAfterSec));
  return reply
    .code(gate.status)
    .send({ error: gate.status === 429 ? "too many failed logins" : "too many logins in progress" });
}

// Login names and secrets longer than this are not credentials anyone uses.
const MAX_USERNAME_LENGTH = 512;
const MAX_SECRET_LENGTH = 16_384;
const LOGIN_MECHS = new Set(["PLAIN", "LOGIN", "XOAUTH2"]);

interface LoginBody {
  username: string;
  password?: string;
  accessToken?: string;
  provider?: string;
  mech?: "PLAIN" | "LOGIN" | "XOAUTH2";
}

/** The `/api/login` body when every field has the expected type, else null. */
function parseLoginBody(body: unknown): LoginBody | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const optional = (v: unknown, max: number) => v === undefined || (typeof v === "string" && v.length <= max);
  if (typeof b.username !== "string" || b.username === "" || b.username.length > MAX_USERNAME_LENGTH) return null;
  if (!optional(b.password, MAX_SECRET_LENGTH) || !optional(b.accessToken, MAX_SECRET_LENGTH)) return null;
  if (b.provider !== undefined && (typeof b.provider !== "string" || !Object.hasOwn(cfg.providers, b.provider))) {
    return null;
  }
  if (b.mech !== undefined && (typeof b.mech !== "string" || !LOGIN_MECHS.has(b.mech))) return null;
  return b as unknown as LoginBody;
}

/**
 * With the Gmail backend configured, a bridge secret is never a mail password:
 * it is answered 401 and is not offered to an IMAP server.
 */
function bridgeSecretOffered(...secrets: (string | undefined)[]): boolean {
  return !!gmailConfig && secrets.some((s) => isBridgeSecret(s));
}

app.post("/api/login", async (req, reply) => {
  const body = parseLoginBody(req.body);
  if (!body) return reply.code(400).send({ error: "invalid login request" });
  if (bridgeSecretOffered(body.password, body.accessToken)) return reply.code(401).send({ error: "auth failed" });

  let providerName: string;
  let provider;
  try {
    providerName = resolveProviderName(cfg, { explicit: body.provider, username: body.username });
    provider = resolveProvider(cfg, providerName);
  } catch {
    return reply.code(400).send({ error: "invalid login request" });
  }
  const creds: Credentials = {
    mech: body.mech ?? (body.accessToken ? "XOAUTH2" : "PLAIN"),
    username: body.username,
    password: body.password,
    accessToken: body.accessToken,
  };

  const gate = await logins.begin(req.ip, body.username);
  if (!gate.ok) return sendLimited(reply, gate);
  // verify by opening an IMAP session once
  let probe;
  try {
    probe = await openImap({ provider, creds });
  } catch (e) {
    gate.finish(isCredentialRefusal(e) ? "refused" : "error");
    log.warn({ ...imapErrorDetails(e), provider: providerName }, "login IMAP probe failed");
    // The mail server's answer stays in the log: a caller without a session learns only that it failed.
    return reply.code(401).send({ error: "auth failed" });
  }
  gate.finish("accepted");

  const slug = `${providerName}:${body.username}`;
  const tag = credentialTag(cfg.vaultKey, creds);
  const account = await recordSignIn({ slug, providerName, provider, creds, ip: req.ip, tag });
  // Reuse the probe as the account's pooled connection instead of logging out
  // and paying a second TCP+TLS+LOGIN when the client's first JMAP call lands.
  pool.adopt(account, probe);
  const token = signSession(
    cfg.sessionHmacKey,
    makeSession({ accountSlug: slug, username: body.username, gen: account.cred_gen, cf: tag }),
  );
  return { token, accountId: String(account.id), apiUrl: `${cfg.publicUrl}/jmap` };
});

// Ends the caller's own session token. Other sessions of the account, and the
// account's stored credentials, stay as they are.
app.post("/api/logout", async (req, reply) => {
  const h = req.headers["authorization"];
  const token = typeof h === "string" && h.startsWith("Bearer ") ? h.slice("Bearer ".length).trim() : "";
  const session = token ? bearerSession(token) : null;
  if (!session) return send401(req, reply);
  store.endSession(tokenHash(token), session.token.exp * 1000);
  return reply.code(204).send();
});

/**
 * True when `creds` differ from what the account row holds: another password
 * or user name, or OAuth instead of a password. PLAIN and LOGIN are two ways
 * to send the same password. An OAuth access token is not a password and
 * renews by itself, so a new one alone does not count.
 */
async function credentialsChanged(existing: AccountRow, creds: Credentials): Promise<boolean> {
  const oauth = (c: Credentials) => c.mech === "XOAUTH2";
  try {
    const stored = await openCredentials(cfg.vaultKey, existing.vault);
    return (
      oauth(stored) !== oauth(creds) ||
      stored.username !== creds.username ||
      (stored.password ?? null) !== (creds.password ?? null)
    );
  } catch {
    return true;
  }
}

// Checks of an account's stored password, by account. A sign-in that offers a
// password other than the stored one starts one after it is answered: the
// stored password is tried once at the mail server. If the server refuses it,
// the offered password replaced it and the credential generation moves; the
// sessions made with the offered password stay valid. If the server still
// accepts it, both are valid (one app password per device) and nothing
// changes. While a check runs, the account's sessions made with other
// credentials wait for its result, at most STORED_CHECK_WAIT_MS.
const storedChecks = new Map<number, { tag: string; done: Promise<void> }>();
const STORED_CHECK_WAIT_MS = 10_000;

/** Wait for a check of the account's stored password, unless `tag` started it. */
async function awaitStoredCheck(accountId: number, tag: string | undefined): Promise<void> {
  const check = storedChecks.get(accountId);
  if (!check || check.tag === tag) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([check.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, STORED_CHECK_WAIT_MS)))]);
  clearTimeout(timer);
}

interface SignIn {
  slug: string;
  providerName: string;
  provider: ProviderConfig;
  creds: Credentials;
  ip: string;
  /** `credentialTag` of `creds`. */
  tag: string;
}

/** Record what a successful sign-in proved; returns the row its session belongs to. */
async function recordSignIn(s: SignIn): Promise<AccountRow> {
  const existing = store.getAccount(s.slug);
  const vault = await sealCredentials(cfg.vaultKey, s.creds);
  const save = (rotate: boolean) =>
    store.upsertAccount({
      slug: s.slug,
      kind: s.providerName,
      host: s.provider.imap.host,
      username: s.creds.username,
      vault,
      rotate,
      rotatedBy: rotate ? s.tag : null,
    });
  if (!existing) return save(false);
  const changed = await credentialsChanged(existing, s.creds);
  // The same password, or the server already refused the stored one.
  if (!changed || existing.cred_refused) return save(changed);
  // One check at a time; the sessions of a sign-in that did not start it are
  // decided by the one running.
  if (!storedChecks.has(existing.id)) checkStoredPassword(existing, s, () => save(true));
  return existing;
}

function checkStoredPassword(existing: AccountRow, s: SignIn, replace: () => AccountRow): void {
  const done: Promise<void> = (async () => {
    let stored: Credentials;
    try {
      stored = await openCredentials(cfg.vaultKey, existing.vault);
    } catch {
      replace();
      return;
    }
    // The check is a login like any other: never for a held address, and a
    // refusal counts.
    const gate = await logins.begin(s.ip, s.creds.username);
    if (!gate.ok) return;
    try {
      const probe = await openImap({ provider: s.provider, creds: stored });
      gate.finish("accepted");
      pool.adopt(existing, probe);
    } catch (e) {
      if (!isCredentialRefusal(e)) {
        gate.finish("error");
        return;
      }
      gate.finish("refused");
      replace();
    }
  })()
    .catch((err) => log.warn({ err: (err as Error).message }, "stored password check failed"))
    .finally(() => {
      if (storedChecks.get(existing.id)?.done === done) storedChecks.delete(existing.id);
    });
  storedChecks.set(existing.id, { tag: s.tag, done });
}

function tokenHash(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * The account and token behind a Bearer token, or null when the token is
 * forged, expired, ended, or was issued under an older credential generation.
 */
function bearerSession(token: string): { account: AccountRow; token: SessionToken } | null {
  const sess = verifySession(cfg.sessionHmacKey, token);
  if (!sess) return null;
  const account = store.getAccount(sess.accountSlug);
  if (!account) return null;
  if (!generationValid(sessionGeneration(sess), sess.cf, account.cred_gen, account.cred_rotated_by)) return null;
  if (store.isSessionEnded(tokenHash(token))) return null;
  return { account, token: sess };
}

app.get("/.well-known/jmap", async (_req, reply) => {
  reply.redirect(`${cfg.publicUrl}/jmap/session`);
});

// A request a browser made (see fromBrowser) is offered Bearer only: web
// clients authenticate with a header, and the browser never shows its own
// password prompt for the proxy.
function send401(req: { headers: Record<string, string | string[] | undefined> }, reply: import("fastify").FastifyReply) {
  reply.header("WWW-Authenticate", fromBrowser(req.headers) ? 'Bearer realm="legacy-proxy"' : 'Basic realm="legacy-proxy", Bearer');
  return reply.code(401).send({ error: "unauthorized" });
}

app.get("/jmap/session", async (req, reply) => {
  const account = await requireAccount(req, reply);
  if (!account) return reply;
  let provider;
  try {
    provider = resolveProvider(cfg, account.kind);
  } catch {
    provider = undefined;
  }
  return buildSession(cfg, account, provider);
});

// `/jmap` requests being answered, per account.
const jmapRequestsInFlight = new Map<number, number>();

app.post("/jmap", async (req, reply) => {
  const account = await requireAccount(req, reply);
  if (!account) return reply;
  const env = req.body;
  if (!isRequestEnvelope(env)) return reply.code(400).send(NOT_REQUEST_PROBLEM);
  for (const cap of env.using) {
    if (!KNOWN_CAPABILITIES.has(cap)) {
      return reply.code(400).send({
        type: "urn:ietf:params:jmap:error:unknownCapability",
        status: 400,
        detail: `Unknown capability: ${String(cap)}`,
      });
    }
  }
  // RFC 8620 §3.6.1: a request over the account's maxConcurrentRequests is
  // refused before any method runs, so the client may replay it. Same answer
  // as Stalwart gives, which JMAP clients already back off and retry on.
  const running = jmapRequestsInFlight.get(account.id) ?? 0;
  if (running >= cfg.limits.maxConcurrentRequests) {
    return reply.code(400).send({
      type: "urn:ietf:params:jmap:error:limit",
      status: 400,
      limit: "maxConcurrentRequests",
      detail: `At most ${cfg.limits.maxConcurrentRequests} requests per account at a time`,
    });
  }
  jmapRequestsInFlight.set(account.id, running + 1);
  try {
    const out = await dispatch(env, {
      methods: makeLegacyMethods({ cfg, pool, store, account, dispatcher }),
      maxCallsInRequest: cfg.limits.maxCallsInRequest,
      maxObjectsInGet: cfg.limits.maxObjectsInGet,
      maxObjectsInSet: cfg.limits.maxObjectsInSet,
      sessionState: `s${account.id}`,
    });
    if (process.env.JMAP_DEBUG === "1") {
      log.info(
        { calls: env.methodCalls.map((c) => c[0]), responses: out.methodResponses },
        "jmap request",
      );
    }
    return out;
  } catch (e) {
    log.error({ err: (e as Error).message }, "jmap dispatch error");
    return reply.code(500).send({ error: "internal" });
  } finally {
    const left = (jmapRequestsInFlight.get(account.id) ?? 1) - 1;
    if (left > 0) jmapRequestsInFlight.set(account.id, left);
    else jmapRequestsInFlight.delete(account.id);
  }
});

// Blob cache bounds. Parts above the per-blob cap stream straight through
// without being cached -- they are the ones streaming exists for, and holding
// one in memory to write it to SQLite would undo that. The total cap keeps the
// database file bounded; the TTL keeps a deleted message's parts from lingering.
const BLOB_CACHE_MAX_BYTES = 2 * 1024 * 1024;
const BLOB_CACHE_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const BLOB_CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

app.get<{ Params: { accountId: string; blobId: string; type: string; name: string } }>(
  "/jmap/download/:accountId/:blobId/:type/:name",
  async (req, reply) => {
    const account = await requireAccount(req, reply);
    if (!account) return reply;
    if (req.params.accountId !== String(account.id)) return reply.code(404).send({ error: "not found" });

    const { decodeBlobId, decodeEmailId } = await import("./mapping/ids.js");

    // RFC 8620 §6.2: clients pass a desired Content-Type via the {type} URL
    // template variable. Honor it (after a sanity check) so the test suite's
    // download-respects-type-param case passes — we don't trust user input
    // implicitly, just allow the small standard set used by JMAP clients. The
    // router has already decoded the segment; decoding it again would turn a
    // literal `%` into an error.
    const requestedType = req.params.type ?? "";
    const allowedType = /^[\w.+-]+\/[\w.+-]+$/.test(requestedType) ? requestedType : null;

    // Uploaded blobs are served straight from SQLite. Email-backed blobs need
    // an IMAP fetch keyed by mailbox + UID + (optional) part id.
    if (req.params.blobId.startsWith("U")) {
      const upload = store.getUpload(req.params.blobId, account.id);
      if (!upload) return reply.code(404).send({ error: "upload not found" });
      reply.header("Content-Type", allowedType ?? upload.ctype);
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.name)}"`);
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(upload.body);
    }

    let parsed;
    try {
      parsed = decodeBlobId(req.params.blobId);
    } catch {
      // RFC 8620 §6.2: a blob the client doesn't have access to (which from
      // their perspective includes "doesn't exist") returns 404. A
      // structurally-malformed blobId from a JMAP perspective is the same:
      // we don't have it.
      return reply.code(404).send({ error: "blob not found" });
    }
    let emailParts;
    try {
      emailParts = decodeEmailId(parsed.emailId);
    } catch {
      return reply.code(404).send({ error: "blob not found" });
    }
    const mbox = store
      .prep(`SELECT id,name FROM mailbox WHERE id = ? AND account_id = ?`)
      .get(emailParts.mailboxIdx, account.id) as { id: number; name: string } | undefined;
    if (!mbox) return reply.code(404).send({ error: "mailbox gone" });

    // A blobId names an immutable (mailbox, uidvalidity, uid, part) tuple, so
    // a cached body is always current. Serving it here skips the IMAP round
    // trip *and* the mailbox lock entirely -- which is what makes re-opening a
    // message with inline images feel instant.
    const cachedBlob = store.getCachedBlob(req.params.blobId, account.id);
    if (cachedBlob) {
      reply.header("Content-Type", allowedType ?? cachedBlob.ctype ?? "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.name)}"`);
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(cachedBlob.body);
    }

    // Downloads can hold the socket for the duration of a large attachment;
    // the bulk connection keeps them from blocking interactive JMAP calls.
    //
    // Stream rather than buffer. Collecting the whole part first meant the
    // client saw no bytes until the entire IMAP transfer finished, so a 20 MB
    // attachment paid its full download time as time-to-first-byte and its
    // full size as proxy memory. Piping straight through overlaps the two
    // transfers and bounds what we hold.
    //
    // Both the pooled connection and the mailbox lock therefore outlive this
    // handler: they are given back when the body stream ends, not when the
    // route returns.
    const lease = await pool.acquire(account, "bulk");
    const client = lease.client;
    const lock = await client.getMailboxLock(mbox.name);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lock.release();
      lease.release();
    };

    try {
      const dl = await client.download(
        `${emailParts.uid}`,
        parsed.partId ?? undefined,
        { uid: true },
      );
      // imapflow answers `{}` rather than null when the FETCH came back
      // without the message or part (expunged, or the server could not
      // produce it), so check for the stream itself.
      if (!dl?.content) {
        release();
        log.warn(
          { mailbox: mbox.name, uid: emailParts.uid, partId: parsed.partId ?? null },
          "download: IMAP server returned no content",
        );
        return reply.code(404).send({ error: "blob not found" });
      }

      const contentType = parsed.partId
        ? dl.meta?.contentType ?? "application/octet-stream"
        : "message/rfc822";

      const source = dl.content as Readable;

      // Tee through a Transform rather than a "data" listener: attaching one
      // would switch the source to flowing mode immediately, and the compress
      // plugin's async onSend hook means fastify does not attach its pipe in
      // the same tick -- chunks emitted in between would be lost. A Transform
      // only pulls when the consumer pulls, so nothing can slip past.
      //
      // Small parts are collected on the way through and cached; once a part
      // grows past the cap we drop what we have and let the rest stream by,
      // which is the case streaming exists for in the first place.
      let collected: Buffer[] | null = [];
      let collectedBytes = 0;
      const tee = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          if (collected) {
            collectedBytes += chunk.length;
            if (collectedBytes > BLOB_CACHE_MAX_BYTES) collected = null;
            else collected.push(chunk);
          }
          cb(null, chunk);
        },
      });

      pipeline(source, tee, (err) => {
        release();
        if (err) {
          // Either IMAP failed mid-literal or the HTTP client hung up while
          // the server was still writing one. Either way this connection is
          // parked mid-FETCH and no later command on it would parse, so drop
          // it; the pool dials a fresh one on the next request.
          log.warn({ err: err.message }, "download stream aborted; recycling connection");
          client.close();
          return;
        }
        if (!collected) return;
        try {
          store.putCachedBlob({
            id: req.params.blobId,
            accountId: account.id,
            ctype: contentType,
            body: Buffer.concat(collected),
            ttlMs: BLOB_CACHE_TTL_MS,
          });
          store.pruneBlobCache(BLOB_CACHE_MAX_TOTAL_BYTES);
        } catch (cacheErr) {
          // Caching is best-effort; a failure here must not fail the download.
          log.warn({ err: (cacheErr as Error).message }, "blob cache write failed");
        }
      });

      reply.header("Content-Type", allowedType ?? contentType);
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.name)}"`);
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(tee);
    } catch (e) {
      release();
      log.error(
        { mailbox: mbox.name, uid: emailParts.uid, partId: parsed.partId ?? null, ...imapErrorDetails(e) },
        "download error",
      );
      return reply.code(502).send({ error: "download failed" });
    }
  },
);

// Upload prune horizon: blobs not referenced within this many ms are GC-able.
// Long enough that a slow client can compose a draft, short enough to bound
// disk. 24h is the JMAP convention for "pending" uploads.
const UPLOAD_RETENTION_MS = 24 * 60 * 60_000;

// Fallback parser for non-JSON, non-text bodies (binary attachments, RFC822,
// images, etc.). Fastify's built-in JSON parser still wins for /jmap; this
// only matches Content-Types that have no other registered parser.
app.addContentTypeParser(
  "*",
  { parseAs: "buffer", bodyLimit: cfg.limits.maxSizeUpload },
  (_req, body, done) => done(null, body),
);

app.post<{ Params: { accountId: string } }>(
  "/jmap/upload/:accountId",
  { bodyLimit: cfg.limits.maxSizeUpload },
  async (req, reply) => {
    const account = await requireAccount(req, reply);
    if (!account) return reply;
    if (req.params.accountId !== String(account.id)) {
      return reply.code(404).send({ error: "not found" });
    }
    const ctype =
      (req.headers["content-type"] as string | undefined)?.split(";")[0]?.trim() ||
      "application/octet-stream";
    const raw = req.body;
    let body: Buffer;
    if (Buffer.isBuffer(raw)) body = raw;
    else if (raw instanceof Uint8Array) body = Buffer.from(raw);
    else if (typeof raw === "string") body = Buffer.from(raw, "utf8");
    else return reply.code(400).send({ error: "empty body" });
    if (body.length === 0) return reply.code(400).send({ error: "empty body" });
    if (body.length > cfg.limits.maxSizeUpload) {
      return reply.code(413).send({ type: "tooLarge" });
    }
    // Opportunistic GC: cheap when the upload table is small, no-op when empty.
    // Runs first so expired uploads do not count against the account's budget.
    store.pruneUploads(UPLOAD_RETENTION_MS);
    if (store.uploadBytes(account.id) + body.length > cfg.limits.maxUploadStoragePerAccount) {
      return reply.code(413).send({
        type: "urn:ietf:params:jmap:error:limit",
        status: 413,
        limit: "maxUploadStoragePerAccount",
        detail: `Pending uploads are limited to ${cfg.limits.maxUploadStoragePerAccount} bytes per account; they expire 24 hours after upload.`,
      });
    }
    const blobId = "U" + crypto.randomUUID().replace(/-/g, "");
    store.putUpload({ id: blobId, accountId: account.id, ctype, body });
    return {
      accountId: String(account.id),
      blobId,
      type: ctype,
      size: body.length,
    };
  },
);

app.get<{ Querystring: { types?: string; closeafter?: string; ping?: string } }>(
  "/jmap/eventsource",
  async (req, reply) => {
    const account = await requireAccount(req, reply);
    if (!account) return reply;
    const origin = (req.headers["origin"] as string | undefined) ?? null;
    // Per RFC 8620 §7.3, `types=*` means all; an explicit comma-separated list
    // is a server-side filter. `closeafter=state` ends the stream after one
    // event (used by mobile clients on cellular). `ping` is the keepalive
    // interval, clamped so a bad client can't pin a connection at 1s.
    const rawTypes = req.query.types ?? "*";
    const types =
      rawTypes === "*" || rawTypes === ""
        ? null
        : rawTypes.split(",").map((s) => s.trim()).filter(Boolean);
    const closeAfter = req.query.closeafter === "state";
    const pingRaw = Number(req.query.ping ?? 30);
    const pingSec = Number.isFinite(pingRaw) ? Math.max(15, Math.min(pingRaw, 300)) : 30;
    hub.add(account, reply, origin, { types, closeAfter, pingSec });
  },
);

// Cache of validated Basic-auth credentials → account. Keyed by sha256 of the
// raw header so we never log or persist plaintext. TTL keeps memory bounded.
const basicAuthCache = new Map<string, { accountId: number; gen: number; tag: string; expires: number }>();
const BASIC_TTL_MS = 5 * 60_000;
// Basic logins in progress, by header and client address: requests that
// arrive together from one address with one header share one login at the
// mail server.
const basicLogins = new Map<string, Promise<AuthOutcome>>();

type AccountRow = import("./state/store.js").AccountRow;
type AuthOutcome =
  | { ok: true; account: AccountRow }
  | { ok: false; status: 401 }
  | { ok: false; status: 429 | 503; retryAfterSec: number };
const UNAUTHORIZED: AuthOutcome = { ok: false, status: 401 };

/** The caller's account, or null after answering 401, 429 or 503. */
async function requireAccount(
  req: { headers: Record<string, string | string[] | undefined>; ip: string },
  reply: import("fastify").FastifyReply,
): Promise<AccountRow | null> {
  const outcome = await authn(req);
  if (outcome.ok) return outcome.account;
  if (outcome.status === 401) send401(req, reply);
  else sendLimited(reply, outcome);
  return null;
}

async function authn(req: {
  headers: Record<string, string | string[] | undefined>;
  ip: string;
}): Promise<AuthOutcome> {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return UNAUTHORIZED;

  if (h.startsWith("Bearer ")) {
    const token = h.slice("Bearer ".length).trim();
    const first = bearerSession(token);
    if (!first) return UNAUTHORIZED;
    await awaitStoredCheck(first.account.id, first.token.cf);
    const session = bearerSession(token);
    return session ? { ok: true, account: session.account } : UNAUTHORIZED;
  }

  if (h.startsWith("Basic ")) {
    const decoded = Buffer.from(h.slice("Basic ".length).trim(), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 1) return UNAUTHORIZED;
    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);
    if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_SECRET_LENGTH) return UNAUTHORIZED;
    // The hold on this address and user name comes first: a held pair gets
    // 429 whatever it sends, a header validated earlier or one whose login
    // is still running included.
    const held = logins.check(req.ip, username);
    if (held && !held.ok) return held;

    const cacheKey = crypto.createHash("sha256").update(h).digest("hex");
    const cached = basicAuthCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      await awaitStoredCheck(cached.accountId, cached.tag);
      const account = store.getAccountById(cached.accountId);
      // A header validated under an older credential generation is asked again.
      if (account && generationValid(cached.gen, cached.tag, account.cred_gen, account.cred_rotated_by)) {
        return { ok: true, account };
      }
      basicAuthCache.delete(cacheKey);
    }
    const runningKey = `${cacheKey}\n${req.ip}`;
    let running = basicLogins.get(runningKey);
    if (!running) {
      running = basicLogin(username, password, cacheKey, req.ip).finally(() => basicLogins.delete(runningKey));
      basicLogins.set(runningKey, running);
    }
    return running;
  }

  return UNAUTHORIZED;
}

async function basicLogin(username: string, password: string, cacheKey: string, ip: string): Promise<AuthOutcome> {
  if (bridgeSecretOffered(password)) return UNAUTHORIZED;

  let providerName: string;
  let provider;
  try {
    providerName = resolveProviderName(cfg, { username });
    provider = resolveProvider(cfg, providerName);
  } catch {
    return UNAUTHORIZED;
  }
  const creds: Credentials = { mech: "PLAIN", username, password };

  const gate = await logins.begin(ip, username);
  if (!gate.ok) return gate;
  let probe;
  try {
    probe = await openImap({ provider, creds });
  } catch (e) {
    gate.finish(isCredentialRefusal(e) ? "refused" : "error");
    log.warn({ err: (e as Error).message, provider: providerName, username }, "basic-auth IMAP probe failed");
    return UNAUTHORIZED;
  }
  gate.finish("accepted");
  const slug = `${providerName}:${username}`;
  const tag = credentialTag(cfg.vaultKey, creds);
  const account = await recordSignIn({ slug, providerName, provider, creds, ip, tag });
  // Keep the validated connection: the JMAP request this auth is for will
  // need one immediately.
  pool.adopt(account, probe);
  basicAuthCache.set(cacheKey, { accountId: account.id, gen: account.cred_gen, tag, expires: Date.now() + BASIC_TTL_MS });
  return { ok: true, account };
}

const port = cfg.port;
app
  .listen({ port, host: process.env.LISTEN_HOST ?? "0.0.0.0" })
  .then(() => log.info({ port, publicUrl: cfg.publicUrl }, "legacy-proxy listening"))
  .catch((e) => {
    log.fatal({ err: e }, "failed to listen");
    process.exit(1);
  });

const shutdown = async () => {
  log.info("shutting down");
  try {
    await app.close();
    await idleManager.closeAll();
    // Best-effort flush so the burst of changes a user just made still reaches
    // any connected SSE / push relay before we exit.
    await dispatcher.flushAll();
    await pool.closeAll();
    store.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  log.error({ err: err.message, stack: err.stack }, "uncaughtException - continuing");
});
process.on("unhandledRejection", (reason) => {
  log.error({ reason: String(reason) }, "unhandledRejection - continuing");
});

export { app };
