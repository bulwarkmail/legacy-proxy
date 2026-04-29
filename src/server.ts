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
  logger: log,
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

app.get("/jmap/session", async (req, reply) => {
  const account = authn(req);
  if (!account) return reply.code(401).send({ error: "unauthorized" });
  return buildSession(cfg, account);
});

app.post("/jmap", async (req, reply) => {
  const account = authn(req);
  if (!account) return reply.code(401).send({ error: "unauthorized" });
  const env = req.body as RequestEnvelope;
  if (!env || !Array.isArray(env.methodCalls) || !Array.isArray(env.using)) {
    return reply.code(400).send({ error: "malformed JMAP request" });
  }
  try {
    const out = await dispatch(env, { cfg, pool, store, account });
    return out;
  } catch (e) {
    log.error({ err: (e as Error).message }, "jmap dispatch error");
    return reply.code(500).send({ error: "internal" });
  }
});

app.get("/jmap/eventsource", async (req, reply) => {
  const account = authn(req);
  if (!account) return reply.code(401).send({ error: "unauthorized" });
  hub.add(account, reply);
});

function authn(req: { headers: Record<string, string | string[] | undefined> }) {
  const h = req.headers["authorization"];
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const token = h.slice("Bearer ".length).trim();
  const sess = verifySession(cfg.sessionHmacKey, token);
  if (!sess) return null;
  return store.getAccount(sess.accountSlug) ?? null;
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

// Decorate hub usage so it's not flagged as unused - push wiring is a follow-up.
void hub;

export { app };
