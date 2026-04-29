# legacy-proxy

> IMAP / SMTP / ManageSieve → JMAP gateway. Use any JMAP client with Gmail,
> Fastmail, your hosting provider's mailbox, or any RFC 3501 IMAP server.

`legacy-proxy` speaks **JMAP for Mail** (RFC 8620 + RFC 8621) on the front
side and **IMAP4rev1 + Submission (SMTP) + ManageSieve** on the back side.
Drop it in front of a legacy mailserver and modern JMAP apps (Bulwark
Webmail, the official `jmap-test-suite`, etc.) treat it as a native JMAP
endpoint.

The full design lives in [`PLAN.md`](./PLAN.md). This README is a quickstart.

---

## Status

This is the v0.1 scaffold described by the plan. It includes:

- ✅ JMAP `Session` resource with full capability table
- ✅ JMAP request envelope, batched `methodCalls`, back-references (`#ref`)
- ✅ `Mailbox/get`, `Email/get`, `Email/query`, `Identity/get`,
  `VacationResponse/get|set`
- ✅ IMAP backend via `imapflow` with per-account connection pool
- ✅ ManageSieve client (RFC 5804) used by `VacationResponse`
- ✅ SMTP submission via `nodemailer`
- ✅ Auth (PLAIN / LOGIN / XOAUTH2), HMAC session tokens, AES-256-GCM
  credential vault
- ✅ State store on `better-sqlite3`
- ✅ EventSource push transport
- ✅ Docker image, `docker-compose.yml`, integration `compose.test.yml`
  with Stalwart
- ✅ Unit tests (vitest, 28 green) and a `jmap-test-suite` runner
- 🚧 `Email/set`, `Email/copy`, `Email/import`, `EmailSubmission/set`,
  `Thread/get`, IMAP IDLE → SSE wiring, WebSocket transport - see
  milestones M3–M6 in `PLAN.md`

---

## Quickstart

```bash
git clone <this repo>
cd legacy-proxy

# generate keys
export VAULT_KEY=$(openssl rand -base64 32)
export SESSION_HMAC_KEY=$(openssl rand -base64 32)

cp providers.example.json providers.json
docker compose up --build
```

Then point a JMAP client at `http://localhost:8080/.well-known/jmap`.

Login (one-time, exchanges IMAP creds for a JMAP session token):

```bash
curl -s http://localhost:8080/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"you@example.com","password":"…","provider":"gmail"}'
```

Use the returned `token` as `Authorization: Bearer …` on all JMAP requests.

---

## Configuration

| env var            | default                            | meaning                                |
| ------------------ | ---------------------------------- | -------------------------------------- |
| `PORT`             | `8080`                             | HTTP listen port                       |
| `PUBLIC_URL`       | `http://localhost:$PORT`           | URL clients see (used in Session URLs) |
| `DATA_DIR`         | `/data`                            | SQLite + blob cache                    |
| `VAULT_KEY`        | (required)                         | base64 32-byte AES-GCM key             |
| `SESSION_HMAC_KEY` | (required)                         | base64 32-byte HMAC-SHA-256 key        |
| `DEFAULT_PROVIDER` | `generic`                          | provider key when `/api/login` omits   |
| `PROVIDERS_FILE`   | `/etc/legacy-proxy/providers.json` | provider catalogue                     |
| `LOG_LEVEL`        | `info`                             | pino level                             |

`providers.example.json` ships ready-to-use templates for Gmail, Fastmail,
and a generic `$IMAP_HOST` / `$SMTP_HOST` / `$SIEVE_HOST` form.

---

## Tests

```bash
npm test                  # unit tests (vitest)
npm run test:integration  # requires compose.test.yml up; gated by RUN_INTEGRATION=1
npm run test:compliance   # runs jmap-test-suite against a live proxy
npm run test:all          # all three
```

The compliance script clones [`jmapio/jmap-test-suite`][1] into
`vendor/jmap-test-suite/` on first run and executes it against the URL in
`PROXY_URL`. Documented allow-listed failures live in
`test/compliance/known-failures.txt` - these are features the upstream
IMAP server cannot offer (e.g. `queryChanges` without `CONDSTORE`).

[1]: https://github.com/jmapio/jmap-test-suite

---

## Architecture

See [`PLAN.md`](./PLAN.md) §2 for the full picture. Module map:

```
src/
  server.ts                  fastify bootstrap
  jmap/                      session, router, capabilities, methods
  imap/                      imapflow pool, fetcher, search compiler
  smtp/                      nodemailer submission
  sieve/                     ManageSieve client + vacation
  auth/                      session tokens, credential vault, providers
  mapping/                   IMAP↔JMAP id codecs, body structure, flags
  state/                     SQLite store + opaque state strings
  push/                      eventsource + websocket
```

---

## License

AGPL-3.0
