# legacy-proxy

IMAP / SMTP / ManageSieve to JMAP gateway. Lets any JMAP client talk to
Gmail, your hosting provider's mailbox, or any RFC 3501 IMAP server.

Front: JMAP for Mail (RFC 8620 + RFC 8621). Back: IMAP4rev1, SMTP
Submission, ManageSieve.

## Status

v0.1. Working:

- JMAP `Session` with the full capability table
- Batched `methodCalls`, back-references (`#ref`)
- `Mailbox/get`, `Email/get`, `Email/query`, `Identity/get`, `VacationResponse/get|set`
- IMAP via imapflow, per-account connection pool
- ManageSieve (RFC 5804), used by `VacationResponse`
- SMTP submission (nodemailer)
- Auth: PLAIN, LOGIN, XOAUTH2. HMAC session tokens. AES-256-GCM vault
- better-sqlite3 state store
- EventSource push
- Docker image + compose files (prod, integration)
- 28 unit tests, jmap-test-suite runner

Not done yet: `Email/set`, `Email/copy`, `Email/import`, `EmailSubmission/set`,
`Thread/get`, IMAP IDLE -> SSE, WebSocket transport.

## Quickstart

You need Docker. Two ways to run it:

### Pull the published image

```bash
mkdir legacy-proxy && cd legacy-proxy

cat > .env <<EOF
VAULT_KEY=$(openssl rand -base64 32)
SESSION_HMAC_KEY=$(openssl rand -base64 32)
EOF
chmod 600 .env

curl -fsSLo providers.json   https://raw.githubusercontent.com/bulwarkmail/legacy-proxy/main/providers.example.json
curl -fsSLo compose.prod.yml https://raw.githubusercontent.com/bulwarkmail/legacy-proxy/main/compose.prod.yml

$EDITOR providers.json    # point the `generic` entry at your IMAP/SMTP host

docker compose -f compose.prod.yml up -d
```

`curl http://localhost:8080/healthz` returns `ok` if it's up. JMAP clients
connect to `http://localhost:8080/.well-known/jmap`.

### Build from source

```bash
git clone https://github.com/bulwarkmail/legacy-proxy.git
cd legacy-proxy
npm run setup
docker compose up -d
```

`npm run setup` writes `.env` and `providers.json`. It won't clobber
existing files. Pass `-- --force` to overwrite.

## Logging in

Trade IMAP credentials for a JMAP session token:

```bash
curl -s http://localhost:8080/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"you@example.com","password":"...","provider":"generic"}'
```

Use the returned `token` as `Authorization: Bearer ...` on JMAP requests.

### Gmail

Gmail wants an [App Password](https://support.google.com/accounts/answer/185833)
(2FA must be on). Use `"provider": "gmail"`. XOAUTH2 works too if you bring
your own tokens.

### TLS and public hosts

The proxy serves plain HTTP. Put Caddy, Traefik, or nginx in front of it
and set `PUBLIC_URL` to the URL clients see. The Session resource bakes
URLs from `PUBLIC_URL`, so a wrong value breaks every JMAP client silently.

## Configuration

| env var            | default                            | notes                                |
| ------------------ | ---------------------------------- | ------------------------------------ |
| `PORT`             | `8080`                             | HTTP listen port                     |
| `PUBLIC_URL`       | `http://localhost:$PORT`           | URL clients see; baked into Session  |
| `DATA_DIR`         | `/data`                            | SQLite and blob cache                |
| `VAULT_KEY`        | required                           | base64 32-byte AES-GCM key           |
| `SESSION_HMAC_KEY` | required                           | base64 32-byte HMAC-SHA-256 key      |
| `DEFAULT_PROVIDER` | `generic`                          | provider key when `/api/login` omits |
| `PROVIDERS_FILE`   | `/etc/legacy-proxy/providers.json` | provider catalogue                   |
| `LOG_LEVEL`        | `info`                             | pino level                           |

`providers.example.json` ships Gmail and a generic
`$IMAP_HOST`/`$SMTP_HOST`/`$SIEVE_HOST` template.

## Tests

```bash
npm test                  # unit tests
npm run test:integration  # needs compose.test.yml; gated by RUN_INTEGRATION=1
npm run test:compliance   # jmap-test-suite against a live proxy
npm run test:all
```

`test:compliance` clones [jmap-test-suite](https://github.com/jmapio/jmap-test-suite)
into `vendor/jmap-test-suite/` and runs it against `PROXY_URL`. Allow-listed
upstream failures live in `test/compliance/known-failures.txt`, mostly
things the IMAP server can't offer (e.g. `queryChanges` without CONDSTORE).

## Architecture

```
src/
  server.ts        fastify bootstrap
  jmap/            session, router, capabilities, methods
  imap/            imapflow pool, fetcher, search compiler
  smtp/            nodemailer submission
  sieve/           ManageSieve client, vacation
  auth/            session tokens, credential vault, providers
  mapping/         IMAP <-> JMAP id codecs, body structure, flags
  state/           SQLite store, opaque state strings
  push/            eventsource, websocket
```

## License

AGPL-3.0
