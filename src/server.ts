import crypto from "node:crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./util/config.js";
import { log } from "./util/log.js";
import { Store } from "./state/store.js";
import { ImapPool } from "./imap/pool.js";
import { resolveProvider } from "./auth/providers.js";
import { sealCredentials, openCredentials, type Credentials } from "./auth/credentials.js";
import { makeSession, signSession, verifySession } from "./auth/session.js";
import { buildSession } from "./jmap/session.js";
import { dispatch, type RequestEnvelope } from "./jmap/router.js";
import { EventSourceHub } from "./jmap/eventsource.js";
import { openImap } from "./imap/client.js";

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const pool = new ImapPool(cfg, store);
const hub = new EventSourceHub();

const app = Fastify({
  loggerInstance: log,
  bodyLimit: cfg.limits.maxSizeRequest,
  disableRequestLogging: false,
});

await app.register(cors, { origin: true });

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

  const providerName = body.provider ?? cfg.defaultProvider;
  const provider = resolveProvider(cfg, providerName);
  const creds: Credentials = {
    mech: body.mech ?? (body.accessToken ? "XOAUTH2" : "PLAIN"),
    username: body.username,
    password: body.password,
    accessToken: body.accessToken,
  };

  // verify by opening an IMAP session once
  try {
    const probe = await openImap({ provider, creds });
    await probe.logout();
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
  return buildSession(cfg, account);
});

app.post("/jmap", async (req, reply) => {
  const account = await authn(req);
  if (!account) return send401(reply);
  const env = req.body as RequestEnvelope;
  if (!env || !Array.isArray(env.methodCalls) || !Array.isArray(env.using)) {
    return reply.code(400).send({ error: "malformed JMAP request" });
  }
  try {
    const out = await dispatch(env, { cfg, pool, store, account });
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

app.get<{ Params: { accountId: string; blobId: string; name: string } }>(
  "/jmap/download/:accountId/:blobId/:name",
  async (req, reply) => {
    const account = await authn(req);
    if (!account) return send401(reply);
    if (req.params.accountId !== String(account.id)) return reply.code(404).send({ error: "not found" });

    const { decodeBlobId, decodeEmailId } = await import("./mapping/ids.js");
    const { withMailbox } = await import("./imap/client.js");
    let parsed;
    try {
      parsed = decodeBlobId(req.params.blobId);
    } catch {
      return reply.code(400).send({ error: "bad blobId" });
    }
    let emailParts;
    try {
      emailParts = decodeEmailId(parsed.emailId);
    } catch {
      return reply.code(400).send({ error: "bad emailId in blobId" });
    }
    const mbox = store.db
      .prepare(`SELECT id,name FROM mailbox WHERE id = ? AND account_id = ?`)
      .get(emailParts.mailboxIdx, account.id) as { id: number; name: string } | undefined;
    if (!mbox) return reply.code(404).send({ error: "mailbox gone" });

    const client = await pool.getForAccount(account);
    try {
      const buf = await withMailbox(client, mbox.name, async () => {
        if (parsed.partId) {
          const dl = await client.download(`${emailParts.uid}`, parsed.partId, { uid: true });
          if (!dl) return null;
          const chunks: Buffer[] = [];
          for await (const chunk of dl.content as AsyncIterable<Buffer>) chunks.push(chunk);
          return { body: Buffer.concat(chunks), contentType: dl.meta?.contentType ?? "application/octet-stream" };
        }
        const dl = await client.download(`${emailParts.uid}`, undefined, { uid: true });
        if (!dl) return null;
        const chunks: Buffer[] = [];
        for await (const chunk of dl.content as AsyncIterable<Buffer>) chunks.push(chunk);
        return { body: Buffer.concat(chunks), contentType: "message/rfc822" };
      });
      if (!buf) return reply.code(404).send({ error: "blob not found" });
      reply.header("Content-Type", buf.contentType);
      reply.header("Content-Disposition", `attachment; filename="${encodeURIComponent(req.params.name)}"`);
      return reply.send(buf.body);
    } catch (e) {
      log.error({ err: (e as Error).message }, "download error");
      return reply.code(502).send({ error: "download failed" });
    }
  },
);

app.get("/jmap/eventsource", async (req, reply) => {
  const account = await authn(req);
  if (!account) return send401(reply);
  const origin = (req.headers["origin"] as string | undefined) ?? null;
  hub.add(account, reply, origin);
});

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

    const providerName = cfg.defaultProvider;
    const provider = resolveProvider(cfg, providerName);
    const creds: Credentials = { mech: "PLAIN", username, password };

    try {
      const probe = await openImap({ provider, creds });
      await probe.logout();
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
    await pool.closeAll();
    store.close();
  } finally {
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (err) => {
  log.error({ err: err.message, stack: err.stack }, "uncaughtException — continuing");
});
process.on("unhandledRejection", (reason) => {
  log.error({ reason: String(reason) }, "unhandledRejection — continuing");
});

// Decorate hub usage so it's not flagged as unused - push wiring is a follow-up.
void hub;

export { app };
