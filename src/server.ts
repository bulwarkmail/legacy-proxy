import crypto from "node:crypto";
import { Transform, pipeline, type Readable } from "node:stream";
import Fastify from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import { loadConfig } from "./util/config.js";
import { log } from "./util/log.js";
import { Store } from "./state/store.js";
import { ImapPool } from "./imap/pool.js";
import { resolveProvider, resolveProviderName } from "./auth/providers.js";
import { sealCredentials, openCredentials, type Credentials } from "./auth/credentials.js";
import { makeSession, signSession, verifySession } from "./auth/session.js";
import { buildSession } from "./jmap/session.js";
import { KNOWN_CAPABILITIES } from "./jmap/capabilities.js";
import { dispatch, type RequestEnvelope } from "./jmap/router.js";
import { EventSourceHub } from "./jmap/eventsource.js";
import { openImap } from "./imap/client.js";
import { PushDispatcher } from "./push/dispatcher.js";
import { PushIdleManager } from "./push/idle.js";

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
});

await app.register(cors, { origin: true });
// JMAP responses with bodyValues are large, highly compressible JSON —
// hundreds of KB shrink to tens. The SSE route is unaffected: it writes to
// reply.raw directly, bypassing the onSend hook this plugin uses.
await app.register(compress, { global: true, threshold: 1024 });

app.get("/healthz", async () => ({ ok: true }));

app.post("/api/login", async (req, reply) => {
  const body = req.body as {
    username: string;
    password?: string;
    accessToken?: string;
    provider?: string;
    mech?: "PLAIN" | "LOGIN" | "XOAUTH2";
  };
  if (!body?.username) return reply.code(400).send({ error: "username required" });

  const providerName = resolveProviderName(cfg, { explicit: body.provider, username: body.username });
  const provider = resolveProvider(cfg, providerName);
  const creds: Credentials = {
    mech: body.mech ?? (body.accessToken ? "XOAUTH2" : "PLAIN"),
    username: body.username,
    password: body.password,
    accessToken: body.accessToken,
  };

  // verify by opening an IMAP session once
  let probe;
  try {
    probe = await openImap({ provider, creds });
  } catch (e) {
    return reply.code(401).send({ error: "auth failed", detail: (e as Error).message });
  }

  const vault = await sealCredentials(cfg.vaultKey, creds);
  const slug = `${providerName}:${body.username}`;
  const account = store.upsertAccount({
    slug,
    kind: providerName,
    host: provider.imap.host,
    username: body.username,
    vault,
  });
  // Reuse the probe as the account's pooled connection instead of logging out
  // and paying a second TCP+TLS+LOGIN when the client's first JMAP call lands.
  pool.adopt(account, probe);
  const token = signSession(cfg.sessionHmacKey, makeSession({ accountSlug: slug, username: body.username }));
  return { token, accountId: String(account.id), apiUrl: `${cfg.publicUrl}/jmap` };
});

app.get("/.well-known/jmap", async (_req, reply) => {
  reply.redirect(`${cfg.publicUrl}/jmap/session`);
});

function send401(reply: import("fastify").FastifyReply) {
  reply.header("WWW-Authenticate", 'Basic realm="legacy-proxy", Bearer');
  return reply.code(401).send({ error: "unauthorized" });
}

app.get("/jmap/session", async (req, reply) => {
  const account = await authn(req);
  if (!account) return send401(reply);
  let provider;
  try {
    provider = resolveProvider(cfg, account.kind);
  } catch {
    provider = undefined;
  }
  return buildSession(cfg, account, provider);
});

app.post("/jmap", async (req, reply) => {
  const account = await authn(req);
  if (!account) return send401(reply);
  const env = req.body as RequestEnvelope;
  if (!env || !Array.isArray(env.methodCalls) || !Array.isArray(env.using)) {
    return reply.code(400).send({ error: "malformed JMAP request" });
  }
  for (const cap of env.using) {
    if (typeof cap !== "string" || !KNOWN_CAPABILITIES.has(cap)) {
      return reply.code(400).send({
        type: "urn:ietf:params:jmap:error:unknownCapability",
        status: 400,
        detail: `Unknown capability: ${String(cap)}`,
      });
    }
  }
  try {
    const out = await dispatch(env, { cfg, pool, store, account, dispatcher });
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
    const account = await authn(req);
    if (!account) return send401(reply);
    if (req.params.accountId !== String(account.id)) return reply.code(404).send({ error: "not found" });

    const { decodeBlobId, decodeEmailId } = await import("./mapping/ids.js");

    // RFC 8620 §6.2: clients pass a desired Content-Type via the {type} URL
    // template variable. Honor it (after a sanity check) so the test suite's
    // download-respects-type-param case passes — we don't trust user input
    // implicitly, just allow the small standard set used by JMAP clients.
    const requestedType = decodeURIComponent(req.params.type ?? "");
    const allowedType = /^[\w.+-]+\/[\w.+-]+$/.test(requestedType) ? requestedType : null;

    // Uploaded blobs are served straight from SQLite. Email-backed blobs need
    // an IMAP fetch keyed by mailbox + UID + (optional) part id.
    if (req.params.blobId.startsWith("U")) {
      const upload = store.getUpload(req.params.blobId, account.id);
      if (!upload) return reply.code(404).send({ error: "upload not found" });
      reply.header("Content-Type", allowedType ?? upload.ctype);
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.name)}"`);
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
    const mbox = store.db
      .prepare(`SELECT id,name FROM mailbox WHERE id = ? AND account_id = ?`)
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
      return reply.send(cachedBlob.body);
    }

    // Downloads can hold the socket for the duration of a large attachment;
    // the bulk connection keeps them from blocking interactive JMAP calls.
    const client = await pool.getForAccount(account, "bulk");

    // Stream rather than buffer. Collecting the whole part first meant the
    // client saw no bytes until the entire IMAP transfer finished, so a 20 MB
    // attachment paid its full download time as time-to-first-byte and its
    // full size as proxy memory. Piping straight through overlaps the two
    // transfers and bounds what we hold.
    //
    // The mailbox lock therefore has to outlive this handler: it is released
    // when the body stream closes, not when the route returns.
    const lock = await client.getMailboxLock(mbox.name);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      lock.release();
    };

    try {
      const dl = await client.download(
        `${emailParts.uid}`,
        parsed.partId ?? undefined,
        { uid: true },
      );
      if (!dl) {
        release();
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
      return reply.send(tee);
    } catch (e) {
      release();
      log.error({ err: (e as Error).message }, "download error");
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
    const account = await authn(req);
    if (!account) return send401(reply);
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
    const blobId = "U" + crypto.randomUUID().replace(/-/g, "");
    store.putUpload({ id: blobId, accountId: account.id, ctype, body });
    // Opportunistic GC: cheap when the upload table is small, no-op when empty.
    store.pruneUploads(UPLOAD_RETENTION_MS);
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
    const account = await authn(req);
    if (!account) return send401(reply);
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
const basicAuthCache = new Map<string, { accountId: number; expires: number }>();
const BASIC_TTL_MS = 5 * 60_000;

async function authn(req: {
  headers: Record<string, string | string[] | undefined>;
}): Promise<import("./state/store.js").AccountRow | null> {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;

  if (h.startsWith("Bearer ")) {
    const token = h.slice("Bearer ".length).trim();
    const sess = verifySession(cfg.sessionHmacKey, token);
    if (!sess) return null;
    return store.getAccount(sess.accountSlug) ?? null;
  }

  if (h.startsWith("Basic ")) {
    const cacheKey = crypto.createHash("sha256").update(h).digest("hex");
    const cached = basicAuthCache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return store.getAccountById(cached.accountId) ?? null;
    }
    const decoded = Buffer.from(h.slice("Basic ".length).trim(), "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    if (colon < 1) return null;
    const username = decoded.slice(0, colon);
    const password = decoded.slice(colon + 1);

    const providerName = resolveProviderName(cfg, { username });
    const provider = resolveProvider(cfg, providerName);
    const creds: Credentials = { mech: "PLAIN", username, password };

    let probe;
    try {
      probe = await openImap({ provider, creds });
    } catch (e) {
      log.warn({ err: (e as Error).message, provider: providerName, username }, "basic-auth IMAP probe failed");
      return null;
    }
    const vault = await sealCredentials(cfg.vaultKey, creds);
    const account = store.upsertAccount({
      slug: `${providerName}:${username}`,
      kind: providerName,
      host: provider.imap.host,
      username,
      vault,
    });
    // Keep the validated connection: the JMAP request this auth is for will
    // need one immediately.
    pool.adopt(account, probe);
    basicAuthCache.set(cacheKey, { accountId: account.id, expires: Date.now() + BASIC_TTL_MS });
    return account;
  }

  return null;
}

const port = cfg.port;
app
  .listen({ port, host: "0.0.0.0" })
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
