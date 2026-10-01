import type {
  FastifyInstance,
  FastifyBaseLogger,
  RawServerDefault,
  RawRequestDefaultExpression,
  RawReplyDefaultExpression,
} from "fastify";
import type { AppConfig } from "../util/config.js";
import {
  CORE_CAPABILITY,
  EMAIL_PUSH_CAPABILITY,
  KEYWORDS_CAPABILITY,
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
  submissionCapabilityProps,
  coreCapabilityProps,
} from "../jmap/capabilities.js";
import { dispatch, type RequestEnvelope } from "../jmap/router.js";
import { JmapError } from "../jmap/errors.js";
import type { GmailConfig } from "./config.js";
import { GmailStore } from "./store.js";
import { GmailConnection } from "./connection.js";
import { GmailApi } from "./api.js";
import { GmailMail } from "./mail.js";
import { GmailPush } from "./push.js";

/** Select Gmail before the legacy handlers, without creating an IMAP account. */
export function registerGmailBackend<L extends FastifyBaseLogger>(
  app: FastifyInstance<
    RawServerDefault,
    RawRequestDefaultExpression,
    RawReplyDefaultExpression,
    L
  >,
  cfg: AppConfig,
  google: GmailConfig,
  store: GmailStore,
  connection: GmailConnection,
  hooks: { push?: GmailPush } = {},
  makeMail = (email: string) =>
    new GmailMail(
      email,
      new GmailApi(email, connection, store),
      store,
      google.writeEnabled ?? false,
      google.composeEnabled ?? false,
      google.aliasesEnabled ?? false,
      google.schedule,
      !!google.push,
      google.labelTags ?? true,
    ),
): void {
  const accounts = new Map<string, GmailMail>();
  const account = (email: string) => {
    let mail = accounts.get(email);
    if (!mail) {
      mail = makeMail(email);
      accounts.set(email, mail);
    }
    return mail;
  };
  if (google.schedule) {
    // Entries left in `sending` by a crash have an outcome known only through the ledger.
    const recovered = store.scheduleRecover();
    if (recovered)
      app.log.warn(
        { recovered },
        "gmail scheduled sends interrupted by a previous shutdown were reconciled",
      );
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        for (const email of store.scheduleDueEmails(Date.now())) {
          if (!google.allowedEmails.has(email) || !store.hasConnection(email))
            continue;
          await account(email)
            .runScheduled()
            .catch((err: unknown) =>
              app.log.error(
                { err: err instanceof Error ? err.message : String(err) },
                "gmail scheduled send worker failed",
              ),
            );
        }
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, 5_000);
    timer.unref();
    app.addHook("onClose", async () => clearInterval(timer));
  }
  let push: GmailPush | undefined;
  if (google.push) {
    push = new GmailPush(
      store,
      account,
      google.allowedEmails,
      google.push,
      app.log,
    );
    hooks.push = push;
    push.start();
    app.addHook("onClose", async () => push?.stop());
  }
  // Without authenticated push the shared secret travels in the query string: never let request logging capture it, configured or not.
  app.post("/gmail/push", { logLevel: "silent" }, async (req, reply) =>
    push
      ? push.receive(req, reply)
      : reply.code(404).send({ error: "not found" }),
  );
  const authenticated = new WeakMap<
    object,
    { email: string; mail: GmailMail; uploadType?: string }
  >();
  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0]!;
    if (path !== "/jmap" && !path.startsWith("/jmap/")) return;
    const auth = req.headers.authorization ?? "";
    let username: string | undefined,
      password = "";
    if (/^Basic /i.test(auth)) {
      const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
      const colon = decoded.indexOf(":");
      if (colon > 0) {
        username = decoded.slice(0, colon).toLowerCase();
        password = decoded.slice(colon + 1);
      }
    } else if (/^Bearer /i.test(auth)) password = auth.slice(7).trim();
    // Only bridge passwords and bridge sign-in tokens select Gmail. Anything else, such as an IMAP app
    // password for the same address, stays with the legacy backend.
    const signedIn = password.startsWith("gmat_") && !username;
    if (!password.startsWith("gmap_") && !signedIn) return;
    const email = signedIn ? store.authenticateToken(password) : store.authenticate(password, username);
    if (
      !email ||
      !google.allowedEmails.has(email) ||
      !store.hasConnection(email)
    ) {
      return reply
        .header("WWW-Authenticate", 'Basic realm="gmail-bridge"')
        .code(401)
        .send({ error: "unauthorized" });
    }
    const mail = account(email);
    authenticated.set(req, { email, mail });
    reply.header("Cache-Control", "no-store");
    if (path.startsWith("/jmap/upload/")) {
      if (!(await mail.canCompose()))
        return reply.code(403).send({ type: "accountReadOnly" });
      const type =
        req.headers["content-type"]?.split(";")[0] ??
        "application/octet-stream";
      authenticated.set(req, { email, mail, uploadType: type });
      // Preserve exact bytes even for text/json uploads: use the existing binary parser.
      req.headers["content-type"] = "application/octet-stream";
    }
  });
  app.addHook("preHandler", async (req, reply) => {
    const selected = authenticated.get(req);
    if (!selected) return;
    const { email, mail } = selected;
    const path = req.url.split("?")[0]!;
    const writable = await mail.writable();
    const canCompose = await mail.canCompose();
    const submissionProps = google.schedule
      ? {
          maxDelayedSend: google.schedule.maxDelayedSend,
          submissionExtensions: { FUTURERELEASE: ["HOLDFOR", "HOLDUNTIL"] },
        }
      : submissionCapabilityProps();
    const extraCaps = canCompose
      ? { [SUBMISSION_CAPABILITY]: submissionProps }
      : {};
    const sessionState = canCompose
      ? google.schedule
        ? "gmail-schedule-v1"
        : "gmail-compose-v1"
      : writable
        ? "gmail-manage-v1"
        : "gmail-readonly-v1";
    if (req.method === "GET" && path === "/jmap/session") {
      const mailProps = {
        maxMailboxesPerEmail: null,
        maxMailboxDepth: 1,
        maxSizeMailboxName: 1000,
        maxSizeAttachmentsPerEmail: canCompose ? 18_000_000 : 50_000_000,
        emailQuerySortOptions: ["receivedAt"],
        mayCreateTopLevelMailbox: writable,
      };
      return reply.send({
        capabilities: {
          [CORE_CAPABILITY]: {
            ...coreCapabilityProps(cfg),
            maxObjectsInGet: 100,
            maxObjectsInSet: 20,
            maxSizeUpload: 25_000_000,
          },
          [MAIL_CAPABILITY]: {},
          // Gmail knows every label's counts, so keyword enumeration is a
          // listing rather than a walk through the mailbox.
          ...(google.labelTags ?? true
            ? { [KEYWORDS_CAPABILITY]: { supportsCounts: true } }
            : {}),
          // Only with push on: without Pub/Sub nothing would ever arrive to
          // report, and advertising it would be a promise we cannot keep.
          ...(push ? { [EMAIL_PUSH_CAPABILITY]: {} } : {}),
          ...extraCaps,
        },
        accounts: {
          [mail.accountId]: {
            name: email,
            isPersonal: true,
            isReadOnly: !writable,
            accountCapabilities: {
              [MAIL_CAPABILITY]: mailProps,
              ...(google.labelTags ?? true ? { [KEYWORDS_CAPABILITY]: {} } : {}),
              ...(push ? { [EMAIL_PUSH_CAPABILITY]: {} } : {}),
              ...extraCaps,
            },
          },
        },
        primaryAccounts: {
          [MAIL_CAPABILITY]: mail.accountId,
          ...(canCompose ? { [SUBMISSION_CAPABILITY]: mail.accountId } : {}),
        },
        username: email,
        apiUrl: `${cfg.publicUrl}/jmap`,
        downloadUrl: `${cfg.publicUrl}/jmap/download/{accountId}/{blobId}/{type}/{name}`,
        uploadUrl: `${cfg.publicUrl}/jmap/upload/{accountId}`,
        state: sessionState,
        ...(push
          ? {
              eventSourceUrl: `${cfg.publicUrl}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
            }
          : {}),
      });
    }
    if (req.method === "GET" && path === "/jmap/eventsource") {
      if (!push) return reply.code(404).send({ error: "not found" });
      const q = req.query as {
        types?: string;
        closeafter?: string;
        ping?: string;
      };
      const rawTypes = q.types ?? "*";
      const types =
        rawTypes === "*" || rawTypes === ""
          ? null
          : rawTypes
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
      const pingRaw = Number(q.ping ?? 30);
      const pingSec = Number.isFinite(pingRaw)
        ? Math.max(15, Math.min(pingRaw, 300))
        : 30;
      reply.hijack();
      push.addStream(
        email,
        reply,
        (req.headers.origin as string | undefined) ?? null,
        {
          types,
          closeAfter: q.closeafter === "state",
          pingSec,
        },
      );
      return;
    }
    if (req.method === "POST" && path === "/jmap") {
      const env = req.body as RequestEnvelope;
      if (
        !env ||
        !Array.isArray(env.using) ||
        !Array.isArray(env.methodCalls) ||
        env.methodCalls.some(
          (c) =>
            !Array.isArray(c) ||
            c.length !== 3 ||
            typeof c[0] !== "string" ||
            !c[1] ||
            typeof c[1] !== "object" ||
            Array.isArray(c[1]) ||
            typeof c[2] !== "string",
        )
      ) {
        return reply.code(400).send({ error: "malformed JMAP request" });
      }
      if (
        env.using.some(
          (c) =>
            c !== CORE_CAPABILITY &&
            c !== MAIL_CAPABILITY &&
            !((google.labelTags ?? true) && c === KEYWORDS_CAPABILITY) &&
            !(push && c === EMAIL_PUSH_CAPABILITY) &&
            !(canCompose && c === SUBMISSION_CAPABILITY),
        )
      )
        return reply
          .code(400)
          .send({
            type: "urn:ietf:params:jmap:error:unknownCapability",
            status: 400,
          });
      if (env.methodCalls.length > cfg.limits.maxCallsInRequest)
        return reply
          .code(400)
          .send({
            type: "urn:ietf:params:jmap:error:limit",
            limit: "maxCallsInRequest",
            status: 400,
          });
      return reply.send(
        await dispatch(env, {
          methods: mail.methods(),
          maxCallsInRequest: cfg.limits.maxCallsInRequest,
          sessionState,
        }),
      );
    }
    if (req.method === "POST" && path.startsWith("/jmap/upload/")) {
      if ((req.params as { accountId: string }).accountId !== mail.accountId)
        return reply.code(404).send({ error: "not found" });
      if (!Buffer.isBuffer(req.body))
        return reply.code(400).send({ error: "Invalid upload" });
      try {
        const type = selected.uploadType ?? "application/octet-stream";
        const blobId = await mail.upload(req.body, type);
        return reply.send({
          accountId: mail.accountId,
          blobId,
          type,
          size: req.body.length,
        });
      } catch {
        return reply.code(413).send({ type: "tooLarge" });
      }
    }
    if (req.method === "GET" && path.startsWith("/jmap/download/")) {
      const p = req.params as {
        accountId: string;
        blobId: string;
        type: string;
        name: string;
      };
      if (p.accountId !== mail.accountId)
        return reply.code(404).send({ error: "not found" });
      try {
        const result = await mail.download(p.blobId);
        const type = /^[\w.+-]+\/[\w.+-]+$/.test(p.type) ? p.type : result.type;
        return reply
          .header("Content-Type", type)
          .header("X-Content-Type-Options", "nosniff")
          .header(
            "Content-Disposition",
            `attachment; filename="${encodeURIComponent(p.name)}"`,
          )
          .send(result.body);
      } catch (error) {
        const status =
          error instanceof JmapError && error.type === "notFound" ? 404 : 502;
        return reply.code(status).send({ error: "download unavailable" });
      }
    }
    return reply.code(404).send({ error: "not found" });
  });
}
