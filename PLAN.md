# legacy-proxy - IMAP/SMTP/Sieve → JMAP gateway

A Node service that speaks **JMAP for Mail** (RFC 8620 + RFC 8621) on the
front side and **IMAP4rev1/2 + Submission (SMTP) + ManageSieve** on the back
side. The goal is to let any JMAP client (Bulwark Webmail, JMAP-compatible
mobile clients, the official `jmap-test-suite`) talk to legacy mailservers
(Gmail, cPanel/Dovecot/Cyrus, generic providers) as if
they were native JMAP servers.

---

## 1. Scope & goals

### Must have (v1)

- **JMAP Core (RFC 8620)** - `Session` resource, `/jmap` request/response
  envelope, batched `methodCalls`, request/response references (`#`), error
  envelopes, `/upload` and `/download` endpoints, `/eventsource` push.
- **JMAP Mail (RFC 8621)** - `Mailbox`, `Email`, `EmailSubmission`,
  `Identity`, `Thread`, `SearchSnippet` and `VacationResponse` types with
  `/get`, `/changes`, `/query`, `/queryChanges`, `/set`, `/copy` where
  defined by the spec.
- **Backend bridges**
  - IMAP4rev1 + extensions (`CONDSTORE`, `QRESYNC`, `IDLE`, `MOVE`,
    `UIDPLUS`, `LIST-EXTENDED`, `SPECIAL-USE`, `LITERAL+`, `ID`, `ENABLE`,
    `BINARY`, `OBJECTID` if present, `COMPRESS=DEFLATE`).
  - SMTP submission (RFC 6409) for `EmailSubmission`.
  - ManageSieve (RFC 5804) for `VacationResponse` and arbitrary Sieve
    scripts via a JMAP extension namespace `urn:bulwark:params:jmap:sieve`.
- **Auth** - Basic + XOAUTH2 (Gmail / generic), pluggable provider config,
  per-account credential vault (encrypted at rest).
- **State tracking** - IMAP `MODSEQ`/`UIDVALIDITY` mapped to opaque JMAP
  `state` strings; per-account SQLite (better-sqlite3) for the mapping cache.
- **Push** - `/eventsource` (RFC 8620 §7.3) driven by IMAP `IDLE` /
  `NOTIFY` per mailbox.
- **WebSocket push (RFC 8887)** as a second transport.
- **Docker** - single container, `node:22-alpine`, exposes one HTTPS port.
- **Compliance** - green run of `jmap-test-suite` against this proxy
  pointed at a known-good IMAP backend (Stalwart, Dovecot, Cyrus, Gmail
  with app-password).

### Nice to have (v1.1+)

- `urn:ietf:params:jmap:contacts` (RFC 8887bis / 9610) backed by CardDAV.
- `urn:ietf:params:jmap:calendars` (RFC 8984) backed by CalDAV.
- JMAP for MDN (RFC 9007).
- Per-method circuit breaker + downgrade for backends without `CONDSTORE`.
- Multi-account aggregation in one Session.

### Explicit non-goals

- Not a mailstore. We do not own message bodies; we proxy/cache.
- No POP3 backend.
- No "JMAP-lite": if a backend cannot satisfy a method we return the
  proper JMAP error (`cannotCalculateChanges`, `unsupportedFilter`, etc.)
  rather than fabricating data.

---

## 2. Architecture

```
                ┌───────────────────────────────────────────────┐
                │                JMAP HTTP/WS surface           │
   client ──▶  │  /.well-known/jmap → /jmap/session             │
                │  POST /jmap   (methodCalls)                   │
                │  GET  /jmap/eventsource                       │
                │  GET  /jmap/ws         (RFC 8887)             │
                │  GET/POST /jmap/{upload,download}/...         │
                └───────────────┬───────────────────────────────┘
                                │
                ┌───────────────▼─────────────┐
                │   request router & batcher  │  enforces maxConcurrentRequests,
                │   (src/jmap/router.ts)      │  resolves "#ref" pointers,
                └───────┬───────┬────────────┘  shapes /get|/changes|/query|/set
                        │       │
        ┌───────────────┘       └────────────────┐
        ▼                                        ▼
 ┌──────────────┐                          ┌──────────────┐
 │ Mailbox      │   Email      Thread      │ EmailSubm.   │  Identity   Vacation
 │  handler     │   handler    handler     │  handler     │  handler    handler
 └──────┬───────┘   └──┬───┘  └──┬─────┘   └──────┬───────┘   │           │
        │              │         │                 │          │           │
        ▼              ▼         ▼                 ▼          ▼           ▼
 ┌────────────────────────────────────────────┐ ┌───────────────────┐ ┌──────────┐
 │           IMAP backend (imapflow)          │ │ SMTP submission   │ │ ManageSv │
 │   connection pool, per-account             │ │ (nodemailer)      │ │ client   │
 │   IDLE supervisor, mailbox cache           │ │                   │ │          │
 └─────────────────────┬──────────────────────┘ └───────────────────┘ └──────────┘
                       │
                       ▼
              ┌──────────────────┐
              │   state store    │  SQLite per account:
              │  (better-sqlite3)│  uidvalidity, highestmodseq,
              └──────────────────┘  uid↔jmapId, mailbox tree,
                                    threadIndex, blob cache.
```

### Module map (final tree)

```
src/
  server.ts                - fastify bootstrap, HTTPS, CORS, rate-limit
  jmap/
    session.ts             - GET /jmap/session
    router.ts              - POST /jmap, batching, refs, errors
    capabilities.ts        - capability table
    upload.ts              - POST /jmap/upload/{accountId}
    download.ts            - GET  /jmap/download/{accountId}/{blobId}/{name}
    eventsource.ts         - GET  /jmap/eventsource
    ws.ts                  - RFC 8887 WebSocket transport
    methods/
      mailbox.ts           - Mailbox/get|changes|query|set
      email.ts             - Email/get|changes|query|queryChanges|set|copy|import|parse
      thread.ts            - Thread/get|changes
      identity.ts          - Identity/get|changes|set
      submission.ts        - EmailSubmission/get|changes|query|set
      vacation.ts          - VacationResponse/get|set      (delegates to Sieve)
      searchSnippet.ts     - SearchSnippet/get
      sieve.ts             - bulwark Sieve extension methods
  imap/
    pool.ts                - keyed pool of authed sessions per account
    client.ts              - imapflow wrapper, capability gating
    idle.ts                - long-lived IDLE workers + state diff emitter
    fetcher.ts             - Email/get bodyParts + structure mapping
    search.ts              - JMAP filter → IMAP SEARCH AST
    threads.ts             - fallback Message-ID/References threading
  smtp/
    submit.ts              - nodemailer transport per identity
  sieve/
    client.ts              - ManageSieve protocol (TCP + STARTTLS)
    vacation.ts            - read/write a single "vacation" script
  auth/
    session.ts             - login, signed JMAP session token
    providers.ts           - Gmail, generic, oauth, app-password
    credentials.ts         - at-rest encryption (libsodium secretbox)
  mapping/
    ids.ts                 - UID ↔ blobId / emailId encoding
    structure.ts           - RFC 8621 BodyStructure projection
    flags.ts               - IMAP flags ↔ JMAP keywords
    mailboxRoles.ts        - SPECIAL-USE / heuristic role inference
  state/
    store.ts               - better-sqlite3 schema + migrations
    states.ts              - opaque state string codec (per-account vector)
  push/
    eventsource.ts         - SSE writer
    websocket.ts           - JMAP WS state push
  store/
    blobs.ts               - staged uploads, content cache
  util/
    headers.ts             - mailparser/structured headers
    rfc5322.ts             - header parse/serialize, structured forms
    base64url.ts
    log.ts                 - pino, scrubbing
test/
  unit/                    - pure-function tests (mappers, codecs)
  integration/             - docker-compose stalwart, real IMAP roundtrips
  compliance/              - `jmap-test-suite` runner against this proxy
```

### Why these libraries

| Concern          | Library                                                                        | Why                                       |
| ---------------- | ------------------------------------------------------------------------------ | ----------------------------------------- |
| HTTP             | `fastify`                                                                      | fast, schema-first, hooks, WS plugin      |
| WebSocket        | `@fastify/websocket`                                                           | matches fastify lifecycle                 |
| IMAP client      | `imapflow`                                                                     | modern, supports CONDSTORE/QRESYNC/IDLE   |
| MIME parse       | `mailparser`                                                                   | maintained by the same author as imapflow |
| MIME build       | `nodemailer/lib/mime-node`                                                     | structural builder for outbound           |
| SMTP             | `nodemailer`                                                                   | de facto, supports XOAUTH2                |
| ManageSieve      | bespoke `src/sieve/client.ts` (RFC 5804 is small) - no maintained npm pkg fits |
| Storage          | `better-sqlite3`                                                               | sync API, perfect for per-account caches  |
| Crypto           | `libsodium-wrappers`                                                           | secretbox for credential vault            |
| Logging          | `pino`                                                                         | low overhead, JSON                        |
| Test runner      | `vitest`                                                                       | TS native, watch mode                     |
| Compliance suite | `jmapio/jmap-test-suite`                                                       | RFC-conformance harness                   |

---

## 3. Data model & ID strategy

JMAP requires stable, opaque IDs that never collide and never reuse. IMAP
gives us `(uidvalidity, uid)` per mailbox. Our encoding:

```
emailId   = base64url(  varint(accountIdx) ‖ varint(mboxIdx) ‖
                        varint(uidvalidity) ‖ varint(uid)  )
mailboxId = base64url(  varint(accountIdx) ‖ varint(mboxIdx) )
threadId  = base64url(  sha1( normalised-Message-ID-root )[:12] )
blobId    = "E" + emailId          (whole RFC822) |
            "P" + emailId + ":" + partId   (a body part)
identityId= "i:" + sha1(addr)[:12]
```

Notes:

- `accountIdx` and `mboxIdx` come from the SQLite tables, never reused.
- If `UIDVALIDITY` rolls (rare on healthy servers, common on Gmail label
  rename), we issue a `cacheable: false` state and force the client to
  resync via `Mailbox/changes` returning `cannotCalculateChanges`.
- `OBJECTID` capability (RFC 8474) is preferred when offered - server
  gives us stable `EMAILID` / `MAILBOXID` values; we still wrap them so
  IDs stay opaque.

### State strings

Per-collection state is `b64u(uidvalidity ‖ highestmodseq)` for `Email`
and per-account `b64u(version)` for `Mailbox` (since IMAP has no native
mailbox-tree CONDSTORE; we bump the counter on every observed structural
change via `LIST` polling + `IDLE` mailbox events where supported).

---

## 4. JMAP method support matrix

Legend: ✅ full, 🟡 partial (documented limitations), ⛔ not in v1.

| Type / method       | get | changes | query |      queryChanges      | set | copy | other                            |
| ------------------- | :-: | :-----: | :---: | :--------------------: | :-: | :--: | -------------------------------- |
| Mailbox             | ✅  |   ✅    |  ✅   |           ✅           | ✅  |  -   |                                  |
| Email               | ✅  |   ✅    |  ✅   | 🟡 (filter-restricted) | ✅  |  ✅  | `import`✅ `parse`✅             |
| Thread              | ✅  |   ✅    |   -   |           -            |  -  |  -   |                                  |
| Identity            | ✅  |   ✅    |   -   |           -            | ✅  |  -   |                                  |
| EmailSubmission     | ✅  |   ✅    |  ✅   |           ✅           | ✅  |  -   |                                  |
| VacationResponse    | ✅  |    -    |   -   |           -            | ✅  |  -   | via Sieve                        |
| SearchSnippet       | ✅  |    -    |   -   |           -            |  -  |  -   |                                  |
| `urn:bulwark:sieve` | ✅  |    -    |   -   |           -            | ✅  |  -   | scripts/{list,activate,validate} |

`queryChanges` falls back to a re-run of `query` + diff when the backend
can't deliver a stable cursor; we surface this honestly via the
`canCalculateChanges` field on the spec'd `Mailbox` etc.

---

## 5. Translation rules (the hard parts)

### 5.1 Mailbox tree

- IMAP `LIST "" "*"` with `RETURN (SPECIAL-USE)`.
- Hierarchy delimiter from `LIST` response → JMAP `parentId`.
- `\Inbox|\Sent|\Drafts|\Trash|\Junk|\Archive|\All|\Flagged` → JMAP `role`.
- Without SPECIAL-USE: heuristic by name + locale dictionary
  (`mapping/mailboxRoles.ts`).
- `totalEmails`, `unreadEmails`, `totalThreads`, `unreadThreads` come from
  `STATUS` (with `CONDSTORE` it's cheap; otherwise we cache).
- Subscriptions: `LSUB`/`LIST (SUBSCRIBED)` → `isSubscribed`.

### 5.2 Email body & structure

- `bodyStructure` is `BODYSTRUCTURE` translated to RFC 8621 §4.1.4 form.
- `textBody` / `htmlBody` selection follows §4.1.4 (preferred multipart).
- `attachments` = body parts with `disposition` = "attachment" or
  non-text content type at non-root level.
- `bodyValues` lazily fetched: only parts named in `fetchTextBodyValues`
  / `fetchHTMLBodyValues` / `fetchAllBodyValues`.
- `MAX_BODY_VALUE_BYTES` honoured, `truncated:true` set.
- `preview` = first 256 chars of plaintext (PREVIEW capability if any,
  else fetched on demand and cached).
- Structured headers (`From`, `To`, `Date`, `MessageId`, …) parsed via
  `mailparser` and exposed in all five JMAP forms (`asText`,
  `asAddresses`, …).

### 5.3 Keywords ↔ flags

| JMAP keyword | IMAP flag         |
| ------------ | ----------------- |
| `$seen`      | `\Seen`           |
| `$flagged`   | `\Flagged`        |
| `$answered`  | `\Answered`       |
| `$draft`     | `\Draft`          |
| `$forwarded` | `$Forwarded`      |
| `$junk`      | `$Junk`           |
| `$notjunk`   | `$NotJunk`        |
| `$phishing`  | `$Phishing`       |
| custom `xyz` | `xyz` (sanitised) |

### 5.4 Email/query → IMAP SEARCH

The full filter grammar is supported; we compile to IMAP `SEARCH` with
`ESEARCH`, `SEARCHRES`, and `SORT` when available. `inMailbox` selects
the box; `inMailboxOtherThan`, `allInThreadHaveKeyword` etc. need a
two-phase query - we run the per-mailbox SEARCH and intersect in process.
Sort keys: `receivedAt`, `from`, `to`, `subject`, `size` - mapped to
`SORT (REVERSE ARRIVAL)` etc.; for unsupported sorts we fall back to
client-side sort over the candidate UID set.

### 5.5 Threads

Prefer server-side `THREAD REFERENCES` / `THREAD ORDEREDSUBJECT`. If
unavailable, build a JWZ-style index in `imap/threads.ts` from the
already-fetched `Message-Id` / `References` / `In-Reply-To` headers.

### 5.6 EmailSubmission

- `Email/set { create }` of a draft → store via `APPEND` to Drafts.
- `EmailSubmission/set { create }` references that email + an identity:
  1. Fetch RFC822 of the draft via IMAP.
  2. Submit via SMTP (auth tied to the identity).
  3. `onSuccessUpdateEmail` / `onSuccessDestroyEmail` applied via IMAP
     `STORE`/`MOVE`.
  4. State machine: `pending` → `final|canceled`. We cannot truly cancel
     once handed to SMTP, so `canceled` is only available before send.
- DSN `delivered`/`displayed` is not surfaced unless MDN feature ships.

### 5.7 VacationResponse / Sieve

- `VacationResponse/set` rewrites the active Sieve script through
  ManageSieve (`PUTSCRIPT vacation` then `SETACTIVE vacation`).
- We **do not** parse arbitrary user Sieve. We own a single managed
  script `bulwark-vacation`; if an existing active script is named
  differently we add an `include :personal "bulwark-vacation"` block
  when the server supports the `include` extension, otherwise we put
  our generated script at the top and document the merge.
- The `urn:bulwark:params:jmap:sieve` extension lets advanced clients
  read/write the raw script set.

### 5.8 Push

- One IDLE worker per (account, frequently-watched mailbox).
- IDLE `EXISTS`/`EXPUNGE`/`FETCH (FLAGS)` events bump `Email` state.
- A 5-second debounce coalesces bursts.
- `/eventsource` writes `event: state` with a JMAP `StateChange` body.
- WS transport mirrors the same payload per RFC 8887.

---

## 6. Auth & multi-account

- Login endpoint `POST /api/login` exchanges (username, password|oauth)
  for a signed JMAP **session token** (HMAC, 7-day default).
- The session resolves to one or more **accounts**. v1 ships
  one-account-per-token; the data model already has `accountIdx` so
  multi-account is a config flip.
- Provider config `config/providers.json`:
  ```json
  {
    "gmail": {
      "imap": { "host": "imap.gmail.com", "port": 993, "tls": true },
      "smtp": { "host": "smtp.gmail.com", "port": 465, "tls": true },
      "sieve": null,
      "auth": { "mech": ["XOAUTH2", "PLAIN"] }
    },
    "generic": {
      "imap": { "host": "$IMAP_HOST", "port": 993, "tls": true },
      "smtp": { "host": "$SMTP_HOST", "port": 587, "starttls": true },
      "sieve": { "host": "$SIEVE_HOST", "port": 4190, "starttls": true },
      "auth": { "mech": ["PLAIN", "LOGIN"] }
    }
  }
  ```
- Credentials encrypted with `libsodium.crypto_secretbox` keyed from
  `LEGACY_PROXY_VAULT_KEY` (32-byte base64).

---

## 7. Storage

`better-sqlite3` per process, file `${DATA_DIR}/proxy.db`. Tables:

```
account(id INTEGER PK, slug TEXT UNIQUE, kind TEXT, host TEXT,
        username TEXT, vault BLOB, created_at INTEGER)

mailbox(id INTEGER PK, account_id INTEGER, name TEXT, parent_id INTEGER,
        delim TEXT, role TEXT, special_use TEXT,
        uidvalidity INTEGER, highest_modseq INTEGER,
        last_seen INTEGER, UNIQUE(account_id,name))

email(  account_id INTEGER, mailbox_id INTEGER, uid INTEGER,
        modseq INTEGER, message_id TEXT, thread_root TEXT,
        size INTEGER, internaldate INTEGER, flags TEXT,
        PK (account_id, mailbox_id, uid))
                                          INDEX(message_id)
                                          INDEX(thread_root)

state_log(account_id INTEGER, kind TEXT, state INTEGER, at INTEGER)

blob(   id TEXT PK, account_id INTEGER, mailbox_id INTEGER,
        uid INTEGER, part TEXT, ctype TEXT, size INTEGER,
        body BLOB, expires INTEGER)

upload( id TEXT PK, account_id INTEGER, ctype TEXT, size INTEGER,
        body BLOB, created_at INTEGER)
```

The cache is **truth-following**, not authoritative: every read goes
through a freshness check (`UIDVALIDITY` + `HIGHESTMODSEQ`), and we
re-derive from IMAP on mismatch.

---

## 8. Configuration

Single-file `.env`:

```
PORT=8080
PUBLIC_URL=https://proxy.example.com
DATA_DIR=/data
VAULT_KEY=base64-32-bytes
SESSION_HMAC_KEY=base64-32-bytes
LOG_LEVEL=info
TLS_CERT=/run/secrets/cert.pem
TLS_KEY=/run/secrets/key.pem
DEFAULT_PROVIDER=generic
PROVIDERS_FILE=/etc/legacy-proxy/providers.json
MAX_CONCURRENT_REQUESTS=10
MAX_OBJECTS_IN_GET=500
MAX_OBJECTS_IN_SET=500
MAX_SIZE_UPLOAD=50000000
MAX_SIZE_REQUEST=10000000
EVENTSOURCE_PING_SEC=30
```

---

## 9. Docker

`Dockerfile` is two-stage `node:22-alpine` with non-root `proxy` user,
`/data` volume, `EXPOSE 8080`, `HEALTHCHECK` hits `/healthz`.

`docker-compose.yml` ships:

```yaml
services:
  legacy-proxy:
    build: .
    ports: ["8080:8080"]
    env_file: .env
    volumes:
      - ./data:/data
      - ./providers.json:/etc/legacy-proxy/providers.json:ro
```

A `compose.test.yml` overlays a Stalwart container so the integration
suite has a real IMAP/SMTP/Sieve server to talk to in CI.

---

## 10. Testing strategy

Three layers - all run in CI on every PR.

### 10.1 Unit (`vitest`, `test/unit/`)

- `mapping/structure.spec.ts` - every BODYSTRUCTURE shape from RFC 3501
  appendix C → expected JMAP `bodyStructure`.
- `mapping/flags.spec.ts` - round-trip keywords ↔ flags.
- `imap/search.spec.ts` - JMAP filter AST → IMAP SEARCH string, golden
  tests.
- `state/states.spec.ts` - codec is bijective.
- `auth/credentials.spec.ts` - vault round-trip, key rotation.

### 10.2 Integration (`test/integration/`)

- Spins up Stalwart (matches the production target server) and Greenmail
  (a known-broken-on-purpose IMAP) in `compose.test.yml`.
- Each test logs in, performs a JMAP method, asserts the IMAP-side
  state.
- Covers happy path for every method in §4 plus failure injection
  (`UIDVALIDITY` change, modseq stall, IDLE drop-and-reconnect).

### 10.3 Compliance (`test/compliance/`)

- Vendors `jmapio/jmap-test-suite` as a git submodule under
  `vendor/jmap-test-suite`.
- A pytest harness boots `legacy-proxy` against the Stalwart container
  and runs the suite via `python -m jmap_test_suite --url …`.
- Exit code is propagated to CI. Any newly-failing test fails the build.
- A documented allowlist (`test/compliance/known-failures.txt`) tracks
  features the upstream IMAP simply cannot offer (e.g. real
  `Email/queryChanges` over a non-CONDSTORE server).

### CI

`.github/workflows/ci.yml`:

```
jobs:
  lint: tsc --noEmit + eslint
  unit: vitest run
  integration: docker compose -f compose.test.yml up -d && vitest run --project integration
  compliance: docker compose -f compose.test.yml up -d && python -m jmap_test_suite ...
  build: docker buildx build --platform linux/amd64,linux/arm64
```

---

## 11. Security

- TLS terminated by the proxy (or upstream - both supported).
- Credentials only in vault BLOB; never logged. `pino` redactor scrubs
  `authorization`, `password`, `xoauth2`, `vault`.
- Per-account rate limits (token bucket) on the JMAP surface.
- CSRF: JMAP only accepts `application/json` with a bearer token; no
  cookies, so CSRF is moot, but `Origin` is checked against `PUBLIC_URL`
  to defeat link-clicking attacks against the eventsource.
- `EmailSubmission` rejects identities not owned by the session.
- Outbound SMTP rate-limit (default 100 msg / 5 min, configurable).

---

## 12. Observability

- `/metrics` (prom-client): per-method latency histogram, IMAP command
  counts, IDLE worker count, push connection gauge.
- Structured pino logs with request-id + jmap methodCallId.
- Optional OpenTelemetry trace export (env-gated).

---

## 13. Milestones

| M   | Scope                                              | Exit gate                                      |
| --- | -------------------------------------------------- | ---------------------------------------------- | ----- | -------------------------- | ------------------------------------ |
| 0   | Repo scaffold, CI, Dockerfile, fastify hello-world | `docker run` returns `/healthz`                |
| 1   | Auth, Session, capability table, providers config  | `GET /jmap/session` returns valid JMAP session |
| 2   | IMAP pool + `Mailbox/get                           | changes                                        | query | set`                       | unit + integration green for Mailbox |
| 3   | `Email/get                                         | changes                                        | query | set`(no body),`Thread/get` | round-trip flag and move via JMAP    |
| 4   | Body fetch, blobs, upload/download                 | render an HTML email through `/jmap/download`  |
| 5   | `Identity`, `EmailSubmission`, SMTP                | send via JMAP, observe in Sent                 |
| 6   | Push: SSE + WebSocket                              | client receives StateChange on new mail        |
| 7   | ManageSieve + `VacationResponse`                   | toggle vacation on/off via JMAP                |
| 8   | `jmap-test-suite` harness, fix to green            | CI compliance job passes                       |
| 9   | Hardening, docs, public README, version 1.0        | tagged release, image on ghcr.io               |

---

## 14. Out-of-scope risks & decisions

- **Gmail's IMAP is non-standard.** Labels look like folders, all-mail
  cross-references, no real `MOVE`. Documented in `docs/gmail.md` and
  covered by a Gmail-specific integration suite using a sandbox
  account.
- **`canCalculateChanges`** must be honest. We return `false` when the
  upstream lacks `CONDSTORE`. Clients fall back per spec.
- **JMAP push over plain HTTP/1.1** uses `text/event-stream`; behind
  some proxies this needs `X-Accel-Buffering: no` - we set it.
- **Sieve dialects vary.** We restrict generated scripts to RFC 5228
  base + `vacation` (RFC 5230) + `fileinto` (RFC 5232). Any
  capability-gated extension we depend on is checked at login.

---

## 15. Done means

- `docker compose up` brings up a working JMAP endpoint at
  `https://localhost:8080/.well-known/jmap`.
- A user supplies IMAP/SMTP/Sieve creds (or Gmail OAuth) and the proxy
  serves a JMAP client end-to-end: list mailboxes, read mail, move,
  flag, send, set vacation, receive push notifications.
- `npm run test:all` (unit + integration + compliance) is green
  against Stalwart.
- Image published to `ghcr.io/bulwarkmail/legacy-proxy:1.0.0`,
  AGPL-3.0, README + `docs/`.
