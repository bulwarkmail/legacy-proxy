# legacy-proxy

> IMAP / SMTP / ManageSieve → JMAP gateway. Use any JMAP client with Gmail,
> your hosting provider's mailbox, or any RFC 3501 IMAP server.

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

### Run the published image (no clone needed)

Requires Docker. Three files land in your working directory; the image is
pulled from `ghcr.io/bulwarkmail/legacy-proxy`.

```bash
mkdir legacy-proxy && cd legacy-proxy

# .env with two random 32-byte keys
cat > .env <<EOF
VAULT_KEY=$(openssl rand -base64 32)
SESSION_HMAC_KEY=$(openssl rand -base64 32)
EOF
chmod 600 .env

# config + compose
curl -fsSLo providers.json   https://raw.githubusercontent.com/bulwarkmail/legacy-proxy/main/providers.example.json
curl -fsSLo compose.prod.yml https://raw.githubusercontent.com/bulwarkmail/legacy-proxy/main/compose.prod.yml

# edit providers.json so the `generic` entry points at your IMAP/SMTP host
docker compose -f compose.prod.yml up -d
```

Verify with `curl http://localhost:8080/healthz` (should return `ok`).
Then point a JMAP client at `http://localhost:8080/.well-known/jmap`.

### Run from a clone (for development, or if you want to build locally)

```bash
git clone https://github.com/bulwarkmail/legacy-proxy.git
cd legacy-proxy
npm run setup            # generates .env + providers.json
docker compose up -d     # builds locally; for the published image use compose.prod.yml
```

`npm run setup` is idempotent and won't overwrite an existing `.env` unless
you pass `-- --force`.

### Logging in

Once the proxy is up, exchange IMAP credentials for a JMAP session token:

```bash
curl -s http://localhost:8080/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"you@example.com","password":"…","provider":"generic"}'
```

Use the returned `token` as `Authorization: Bearer …` on all JMAP requests.

### Connecting Gmail

Gmail no longer accepts plain account passwords over IMAP. Use an
[App Password](https://support.google.com/accounts/answer/185833) (requires
2-Step Verification) and pass `"provider": "gmail"`:

```bash
curl -s http://localhost:8080/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"you@gmail.com","password":"<16-char app password>","provider":"gmail"}'
```

XOAUTH2 is also supported if you bring your own OAuth tokens.

### Exposing on a real host

The proxy speaks plain HTTP - terminate TLS in front of it (Caddy, Traefik,
nginx) and set `PUBLIC_URL` in `.env` to the URL clients will see, e.g.
`PUBLIC_URL=https://jmap.example.com`. The Session resource hands out URLs
based on `PUBLIC_URL`, so JMAP clients break if it's wrong.

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

`providers.example.json` ships ready-to-use templates for Gmail,
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
