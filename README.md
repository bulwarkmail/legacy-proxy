# legacy-proxy

> Pre-1.0. The wire shapes, storage formats, and config keys can change without
> notice. There is no third-party security audit. Run it for development,
> testing, and self-hosted experiments.

## About

`legacy-proxy` is a translation layer that puts a JMAP for Mail server in
front of a classic IMAP / SMTP / ManageSieve / CardDAV stack. It speaks
RFC 8620 + RFC 8621 to clients, and standard mailbox protocols to whatever
server already holds the user's mail. No new mail store, no migration: the
mail keeps living in the existing IMAP server, and a modern JMAP client
sees the account as if it were native.

The motivation is simple. JMAP is a much better fit for modern clients than
IMAP. It batches operations into a single HTTP round-trip, ships diffs
through `*/changes` instead of forcing clients to walk every UID, pushes
state notifications over `EventSource` and Web Push, and exposes contacts
and vacation responders as first-class objects instead of out-of-band Sieve
scripts and CardDAV trees the user has to discover. But almost nobody
operates a JMAP backend. Gmail, Fastmail aside, most hosting providers, ISPs,
and self-hosted setups still ship IMAP only. This proxy lets a JMAP client
target any of them without the operator having to swap their mail server.

What that means concretely:

- A JMAP client (Bulwark webmail, JMAP-enabled mobile apps, custom tooling)
  authenticates against this proxy. The proxy holds an IMAP connection
  open to the real mail server and translates each JMAP method into the
  equivalent IMAP / SMTP / ManageSieve / CardDAV operation.
- State changes get fanned out through both Server-Sent Events and the
  RFC 8620 §7.2 push subscription mechanism. A dedicated IDLE socket per
  active account turns IMAP `EXISTS` / `EXPUNGE` / `FETCH FLAGS`
  notifications into JMAP `EmailDelivery` / `Email` / `Mailbox` state bumps
  in real time.
- Credentials are sealed into an AES-256-GCM vault stored in SQLite, so the
  proxy can keep working with the upstream server across restarts without
  asking the user to log in again.
- Auth on the front accepts either a Bearer token minted by the proxy's
  `/api/login` endpoint or plain HTTP Basic, which is enough to run the
  upstream JMAP compliance suite straight against it.

It is built primarily for [Bulwark Mail](https://bulwarkmail.com)'s webmail,
but the proxy is independent of any one client: anything that speaks
RFC 8621 should work, and the test suite exercises it with the official
`jmapio/jmap-test-suite`.

## What works

JMAP method coverage:

| Type              | Methods                                                              |
| ----------------- | -------------------------------------------------------------------- |
| Core              | `Core/echo`, `Blob/copy` (rejects with `fromAccountNotFound`)        |
| Mailbox           | `get`, `query`, `queryChanges`, `changes`, `set`                     |
| Email             | `get`, `query`, `queryChanges`, `changes`, `set`, `copy`, `import`, `parse` |
| SearchSnippet     | `get` (returns null snippets; IMAP exposes no match offsets)         |
| Thread            | `get`, `changes` (persistent header index in SQLite, updated incrementally per folder) |
| Identity          | `get`, `set`, `changes`                                              |
| EmailSubmission   | `get`, `query`, `changes`, `set` (with `onSuccessUpdateEmail` / `onSuccessDestroyEmail`) |
| VacationResponse  | `get`, `set`, `changes` (full body + dates round-tripped through Sieve)  |
| PushSubscription  | `get`, `set` (verification handshake, relay forwarding, expiry caps) |
| AddressBook       | `get`, `changes`, `set` (extended MKCOL / PROPPATCH / DELETE via CardDAV) |
| ContactCard       | `get`, `query`, `queryChanges`, `changes`, `set` (PUT / DELETE via CardDAV) |
| Quota             | `get` (stub returning empty list, so probing clients don't error)    |

Capabilities advertised on the Session resource:

- `urn:ietf:params:jmap:core`
- `urn:ietf:params:jmap:mail`
- `urn:ietf:params:jmap:submission`
- `urn:ietf:params:jmap:vacationresponse`
- `urn:ietf:params:jmap:contacts` (only when the active provider has CardDAV)
- `urn:bulwark:params:jmap:sieve` (vendor capability used by the vacation handler)

Transport:

- `POST /jmap`, `GET /jmap/session`, `/.well-known/jmap` redirect.
- `GET /jmap/download/{accountId}/{blobId}/{type}/{name}` for both
  IMAP-backed message blobs and previously-uploaded blobs.
- `POST /jmap/upload/{accountId}` with a 24h retention sweep.
- `GET /jmap/eventsource` (RFC 8620 §7.3). Real `state` events on every counter
  bump, with `types`, `closeafter`, and `ping` query params.
- `PushSubscription/set` runs a one-shot `PushVerification` POST against the
  subscriber URL; once verified, every state change is forwarded as a
  `StateChange` POST. 404 / 410 responses retire the subscription; 8
  consecutive non-2xx responses also retire it.
- IMAP IDLE: the proxy keeps a dedicated IMAP socket per account that has at
  least one verified push subscription, watching INBOX. New arrivals bump
  `EmailDelivery` (and `Email`, `Mailbox`); other-device flag changes bump
  `Email`; expunges bump `Email` and `Mailbox`.

Backends:

- IMAP via [imapflow](https://github.com/postalsys/imapflow), one connection
  per account in a request-path pool (separate from the IDLE socket).
- ManageSieve (RFC 5804) for the vacation autoresponder.
- SMTP Submission via nodemailer.
- CardDAV (RFC 6352) for AddressBook and ContactCard. Reads are live
  PROPFIND / `addressbook-multiget`; writes are `PUT` with `If-None-Match: *`
  (create) or `If-Match` (update), `DELETE`, extended `MKCOL` (RFC 5689) and
  `PROPPATCH`. Cards are re-serialised as vCard 4.0 on update; properties the
  JSContact projection doesn't model (PHOTO, IMPP, X-*, …) are carried over
  untouched.
  A CardDAV account with no collections at all (a fresh Radicale user, for
  example) gets a `Contacts` address book created on the first
  `ContactCard/set`.

Auth and storage:

- IMAP-side mechanisms: `PLAIN`, `LOGIN`, `XOAUTH2`. Bring-your-own-token works
  for OAuth providers.
- HTTP-side: `Authorization: Bearer <token>` (HMAC-SHA-256 session tokens) and
  `Authorization: Basic ...` (probed against IMAP, then cached for 5 min).
- Credentials sealed with AES-256-GCM and stored in SQLite.
- State, mailboxes, identities, vacation cache, push subscriptions, and the
  upload table all live in a single better-sqlite3 database under `DATA_DIR`.

Sort and filter:

- Server advertises `emailQuerySortOptions: ["receivedAt"]`. A pure
  `receivedAt` sort (what clients send by default) is answered from UID order
  with no per-message FETCH. The handler also accepts `size`, `from`, `to`,
  `subject`, `sentAt`, and `hasKeyword` (those pay a per-match FETCH).
- `hasAttachment` filter is rejected: IMAP without a server-side flag for it
  cannot answer cheaply.
- `*/changes` and `Email/queryChanges` use a real change log seeded by
  IDLE / `Email/set` / `Mailbox/set`, so a client with a recent `sinceState`
  gets a precise diff. When the log has rotated past the requested state, the
  proxy returns `cannotCalculateChanges`.

## Not implemented

- WebSocket transport (`@fastify/websocket` is in the deps tree but no `/jmap/ws`
  handler is registered, so the capability is not advertised).
- CardDAV cards live in exactly one collection, so `ContactCard/set` rejects
  `addressBookIds` changes (moving a card between books) with
  `invalidProperties`. `AddressBook/set` only persists `name` and
  `description`; `isDefault`, `sortOrder`, `isSubscribed` and `color` have no
  CardDAV equivalent and are accepted but ignored. No sharing (`shareWith`).
- The JSContact ⇄ vCard translation covers name, nicknames, emails, phones,
  organisations, titles, addresses, notes, links, anniversaries, kind and
  group members. Other JSContact properties sent on create (media,
  onlineServices, …) are dropped; on update the corresponding vCard lines
  are preserved as-is.
- Multi-mailbox membership: an Email lives in exactly one IMAP folder. JMAP
  operations that try to add or remove a mailbox membership treat the move as
  a copy + expunge, which produces a new id rather than preserving the old
  one. The compliance allowlist documents the affected upstream tests.
- `Thread/changes` for the case where the last email of a thread is destroyed
  (the index has no live thread to look up; allow-listed).
- Cross-account `Blob/copy` (no shared blob namespace between IMAP accounts).
- Web Push payload encryption (`keys` on PushSubscription is accepted but
  ignored; the Bulwark relay re-encrypts with its own VAPID key).

## Quickstart

You need Docker.

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

$EDITOR providers.json   # point the `generic` entry at your IMAP/SMTP/Sieve/CardDAV hosts

docker compose -f compose.prod.yml up -d
```

`curl http://localhost:8080/healthz` returns `{"ok":true}` once the server is
up. Clients connect via `http://localhost:8080/.well-known/jmap`.

### Build from source

```bash
git clone https://github.com/bulwarkmail/legacy-proxy.git
cd legacy-proxy
npm run setup
docker compose up -d
```

`npm run setup` writes `.env` with fresh keys and copies `providers.example.json`
to `providers.json`. It refuses to clobber existing files; pass `-- --force`
to overwrite both.

For local development without Docker:

```bash
npm install
npm run setup
npm run dev          # tsx watch, reads .env automatically
```

## Logging in

Two flows are supported.

### Trade IMAP credentials for a Bearer token

```bash
curl -s http://localhost:8080/api/login \
  -H 'content-type: application/json' \
  -d '{"username":"you@example.com","password":"...","provider":"generic"}'
```

The response carries `{ token, accountId, apiUrl }`. Use the token as
`Authorization: Bearer <token>` on subsequent JMAP requests. The login endpoint
opens a probe IMAP session with the supplied credentials, seals them into the
vault, and only mints a token if IMAP accepts.

`provider` is the key into `providers.json`. When omitted, the proxy picks it
from the email domain of `username` (see [Provider selection](#provider-selection)),
falling back to `DEFAULT_PROVIDER`. For OAuth providers, pass `accessToken`
instead of `password` and the proxy will use `XOAUTH2`.

### HTTP Basic

`Authorization: Basic <base64(user:pass)>` works on every JMAP endpoint.
The first request in a 5 minute window costs one IMAP probe; subsequent
requests reuse the cached account. Useful for compliance suite runs and
servers that already terminate auth at a reverse proxy.

Basic auth carries no explicit provider, so the proxy selects one from the
email domain of the username (see [Provider selection](#provider-selection)).
This is what lets a JMAP client like the Bulwark webmail front several IMAP
backends through one proxy without any client-side change: the user just types
their email, and the domain routes them to the right provider.

### Provider selection

Every login resolves to exactly one provider key from `providers.json`, in this
order:

1. an explicit `provider` in the `/api/login` body, if present;
2. the provider whose `domains` list contains the username's email domain
   (case-insensitive). This mirrors RFC 8620 §2.2, which uses the email domain
   as the routing key for service autodiscovery;
3. `DEFAULT_PROVIDER` otherwise.

Give each provider a `domains` array to enable step 2:

```json
{
  "posteo":      { "domains": ["posteo.de", "posteo.net"], "imap": { ... }, ... },
  "mailbox-org": { "domains": ["mailbox.org"],             "imap": { ... }, ... }
}
```

See `providers.two-servers.example.json` for a full two-provider catalogue.
If two backends share one email domain, that domain can only map to a single
provider. Use the explicit `/api/login` `provider` field for the exception.

### Gmail

Gmail wants an [App Password](https://support.google.com/accounts/answer/185833)
(2FA must be on). Use `"provider": "gmail"`. XOAUTH2 also works if you bring
your own access token.

### Experimental Gmail API connection

This opt-in backend exposes Gmail labels, messages, threads and downloads over
JMAP using the Gmail API, with read-only consent by default. The existing `gmail` IMAP
provider remains available separately. This is an experimental compatibility
backend, not a complete RFC 8621 implementation.

#### Google Cloud setup (done once per deployment)

Nothing in this repository is tied to a particular Google project: every operator
brings their own OAuth client, and Google's rules for that client decide who can
connect and for how long. In the [Google Cloud console](https://console.cloud.google.com/):

1. Create a project and enable the **Gmail API** (and **Pub/Sub** if you want push,
   see below).
2. Configure the **OAuth consent screen** with the scope you intend to use:
   `https://www.googleapis.com/auth/gmail.readonly` for read-only, or
   `https://www.googleapis.com/auth/gmail.modify` for management and composition.
   Both are *restricted* scopes in Google's classification.
3. Choose the **user type** and **publishing status** deliberately:
   - **Internal** (Google Workspace organisations only): anyone in the organisation
     can connect, no verification, tokens do not expire. The best option when the
     proxy serves one company.
   - **External, Testing**: only addresses listed as *test users* (max 100) can
     connect, and Google **expires refresh tokens after 7 days**: every account must
     be reconnected weekly. Fine for a first try, not for daily use.
   - **External, In production** (press *Publish app*; no verification request
     needed): refresh tokens no longer expire, users see Google's "unverified app"
     warning once and continue via *Advanced*, and the app is capped at 100 users.
     This is the practical setting for personal and small self-hosted deployments.
   - Google's **app verification** (security assessment for restricted scopes) is
     only required to remove the warning or exceed 100 users, i.e. to run a public
     service.
4. Create an OAuth client of type **Web application** and register this exact
   redirect URI, replacing the origin with the proxy's `PUBLIC_URL`:

   ```text
   https://bridge.example.com/auth/google/callback
   ```

Store the downloaded client JSON outside the repository, readable only by the
service account. Configure the proxy:

```dotenv
PUBLIC_URL=https://bridge.example.com
GMAIL_OAUTH_CLIENT_FILE=/etc/legacy-proxy/google-oauth.json
GMAIL_ALLOWED_EMAILS=tester@gmail.com
```

`GMAIL_ALLOWED_EMAILS` is a required comma-separated allowlist of addresses and/or
whole domains written as `@example.com` (for instance
`GMAIL_ALLOWED_EMAILS=@example.com,someone@gmail.com`). The Gmail profile
returned by Google determines whether the account is allowed; form values and
login hints are not trusted. Visit `/auth/google/start` and click **Connect Gmail**.
The flow uses PKCE, a browser-bound HttpOnly cookie, and single-use state expiring
after ten minutes. Callback logs are suppressed and no tokens are returned to
the browser. Restarting the service invalidates pending authorization flows;
start again if this happens during consent.

Self-service onboarding: the first successful consent for an account issues a bridge
password, and the result page shows server, username and password exactly once,
bound to that browser and expiring after two minutes. Reconnecting later (for example
after a revoked grant or Testing's seven-day expiry) keeps the existing password
unless "Issue a new bridge password" is ticked, which replaces it. A pending consent
lives in an encrypted, browser-bound cookie rather than in server memory, so abandoned
or scripted starts cannot block other users. `npm run gmail:password` remains
available for operators.

#### Sign in with Google from a mail client (no bridge password)

Register the mail client with `GMAIL_OAUTH_CLIENTS` and the bridge also becomes an
OAuth 2.0 authorization server for it (authorization code with PKCE S256, public
clients, metadata at `/.well-known/oauth-authorization-server`):

```bash
GMAIL_OAUTH_CLIENTS='[{"id":"bulwark","redirectUris":["https://webmail.example.com/*/auth/callback"]}]'
```

Redirect URIs match exactly, except that `*` stands for one path segment (Bulwark
puts the locale there). The client sends the user to `/oauth/authorize`; the user
picks a Google account, and the bridge checks it against `GMAIL_ALLOWED_EMAILS`. An
account whose Gmail access is already stored signs in without a consent screen. Any
other account is sent to Google's consent once, and its grant is stored as by
**Connect Gmail**. The client then gets a single-use code, valid for a minute, and
exchanges it at `/oauth/token` for a bridge access token (`gmat_…`, one hour, Bearer
only) and a refresh token (`gmrt_…`). The refresh token lasts while it keeps being
used, up to 180 days between uses. `/oauth/revoke` ends a refresh token and the
access tokens under it. Only hashes of these tokens are stored. They are separate
from the bridge password: every signed-in client has its own, signing in again
revokes nothing, and disconnecting the account deletes them all. Google tokens never
leave the bridge.

In Bulwark, give the bridge's server entry an OAuth client ID equal to the
registered `id`, and optionally a button label such as "Sign in with Google".

Tokens are encrypted with the existing `VAULT_KEY` in `DATA_DIR/gmail.sqlite3`.
The same database caches metadata, message bodies and attachment bytes in plaintext;
protect `DATA_DIR` and its backups. Cached values expire and are bounded to 256 MiB
of logical data per account (SQLite may retain free pages).
Google Testing refresh tokens with Gmail scopes expire after seven days; reconnect
when consent expires or is revoked.

To remove an account, revoke its Google grant and delete everything the bridge stored
for it (tokens, bridge password, cache, draft mappings, send ledger and queues):

```bash
npm run gmail:disconnect -- tester@gmail.com
```

Also remove the address from `GMAIL_ALLOWED_EMAILS` if it should not connect again.

After building, verify the saved connection (including token refresh when needed):

```bash
npm run gmail:check -- tester@gmail.com
```

This refreshes the profile/label snapshot and prints only counts. JMAP reads retry
temporary Google rate/server errors at most twice with exponential backoff and a
shared account cooldown. Long Retry-After delays return an error immediately;
permanent permission errors are not retried. The diagnostic snapshot command itself
does not retry. Token refresh is coalesced within one process; run a single writer
per data directory during this experimental stage. Google requests have timeouts,
and failed checks retain the last snapshot.

Create a dedicated JMAP password after consent, using a new private output path:

```bash
npm run gmail:password -- tester@gmail.com /private/path/jmap-login.json
```

The file contains `serverUrl`, `username` and `password` for the client's custom
JMAP account. Only a SHA-256 hash of this randomly generated password is stored.
Reissuing it immediately revokes the previous bridge password. Basic auth with
that username/password or Bearer auth with the bridge password is supported;
Google tokens stay on the server. Only passwords starting with `gmap_` select the
Gmail API backend; any other password for the same address, such as an IMAP App
Password, is handled by the regular IMAP backend. Removing the email from the
allowlist and restarting also blocks access, including to cached data.

Expose `/jmap`, `/jmap/*` and `/.well-known/jmap` alongside the OAuth routes at
the HTTPS reverse proxy. Account and mailbox rights stay read-only unless both
the operator enables writes and the account grants modify consent. Uploads and
submission remain unavailable until composition is enabled. Changes are synced
incrementally (see below); with push configured, clients also get EventSource
notifications instead of polling.

To enable mail management, add `https://www.googleapis.com/auth/gmail.modify`
to the Google consent configuration and set `GMAIL_WRITE_ENABLED=true`. Restart,
then reconnect through `/auth/google/start` and grant the requested permission.
The existing bridge password and account ID remain valid; reload the mail client
so it receives the new session rights. Setting the flag false disables writes
again without changing the password. Old or incomplete grants remain read-only.

Supported updates: `$seen`, `$flagged`, `$important`, mailbox membership for Inbox,
Spam, Trash and user labels; create/rename/delete flat user labels. Full keyword
maps and per-key JSON Pointer patches work. Unsupported custom keywords, draft
changes, nested label parents and permanent mail deletion are rejected.
Draft creation/uploads/sending require the additional compose flag below. Label deletion never deletes messages: nonempty labels
require `onDestroyRemoveEmails=true` to remove their membership from messages.

In management mode, All mail has the `archive` role for client interoperability.
Moving a message to All mail removes Inbox/Spam/Trash while retaining its user
labels. The All mail view still contains every message, including Inbox and
Trash. Other full mailbox replacements replace writable folder memberships;
keyword-backed/system memberships remain managed by their corresponding fields.
The server returns normalized `mailboxIds`/`keywords` after an update.

Writes are serialized per account and limited to 20 objects per set call. Each
patch is validated before sending one Gmail modify request per message. Set
responses report partial failures by ID. Ambiguous writes are not automatically
retried (including label creation); refresh before manually retrying. Successful
and uncertain writes invalidate caches and advance a persistent local revision;
reads started before invalidation cannot repopulate those cache entries. Changes
made in Gmail itself are picked up by the incremental sync described below.

Set `GMAIL_COMPOSE_ENABLED=true` together with `GMAIL_WRITE_ENABLED=true` to enable
composition. The existing verified `gmail.modify` grant is sufficient; reload the
client to discover the submission capability. By default the only identity is the
connected account address.

Set `GMAIL_ALIASES_ENABLED=true` to also expose the addresses configured under
Gmail's "Send mail as" (`users.settings.sendAs`, readable with the existing
`gmail.modify` grant, no new consent) as JMAP identities. The primary address keeps
its identity id and gains Gmail's display name and reply-to; every alias whose
verification status is `accepted` gets a stable id derived from the account and the
address. Pending or failed aliases are never offered. Identities are read-only:
create or edit aliases in Gmail or the Workspace admin console. Signatures are left
empty on purpose so the client's own signatures apply; Google signatures are not
imported. Settings are cached for five minutes; if Gmail settings are temporarily
unreachable, `Identity/get` degrades to the primary address. Drafts and MIME
imports may use any listed address in `From`. Before sending, the bridge re-reads
the settings: an alias removed meanwhile yields `forbiddenFrom` and the draft is
retained, and a draft whose `From` does not match the chosen identity is refused.

The compose path supports plain text, HTML, Cc/Bcc, reply headers, MIME body
structures, inline parts and uploaded or existing message attachments. New mail
must target Drafts. Draft saves use native Gmail drafts; Bulwark replaces an edited
draft by creating the replacement before discarding the old copy. Email/set destroy
can discard a draft, but cannot permanently delete received/sent mail. Email/import
into Drafts creates a native Gmail draft (From must be one of the account's
identities). Email/import into any other writable mailbox (Inbox, Spam, Trash,
user labels, or All mail alone to archive) files the MIME through
`users.messages.import` with `GMAIL_WRITE_ENABLED` alone: any From is accepted,
`$seen`, `$flagged` and `$important` map to Gmail's labels, other keywords are
dropped, Gmail orders the message by its Date header (`receivedAt` is ignored)
and the message is never marked as spam. Sent and Drafts cannot be import
targets except through the draft path.

Uploads preserve exact bytes (including JSON attachments), are scoped to the
account, expire after 24 hours and are capped at 25 MB each / 100 MB total per
account. Complete encoded MIME is capped at 25 MB; the session advertises an 18 MB
attachment allowance to leave room for MIME encoding. Upload/draft metadata lives
in protected SQLite, separately from the disposable read cache. Do not publish it.

Submission uses `drafts.send` and Gmail's native Sent filing. A durable intent is
recorded before calling Google; requests to send that same draft are not replayed
after an uncertain outcome, even across restarts. Only timeouts, dropped connections
and 5xx answers count as uncertain: a send Google provably never received (expired or
revoked authorization, rate limiting, a full request queue) or refused with a 4xx
answer releases the intent, so the draft can be sent again once the cause is fixed.
Check Sent before composing a new copy if the outcome is unknown; a draft whose send
is uncertain can still be discarded. This is per-draft deduplication, not
deduplication of separately created messages. Successfully sent drafts keep a stable JMAP email ID
through a persisted mapping to Gmail's new message ID. Existing drafts edited
outside the bridge are checked before sending/discarding to avoid acting on a
replacement the client has not seen.

Set `GMAIL_SCHEDULE_ENABLED=true` to add a persistent delayed-send queue (RFC 4865
FUTURERELEASE: `HOLDFOR` seconds or `HOLDUNTIL` timestamp in the envelope
`mailFrom` parameters). The session then advertises `maxDelayedSend`
(`GMAIL_MAX_DELAYED_SEND`, default 30 days) and `submissionExtensions.FUTURERELEASE`,
which is what Bulwark's "schedule send" and "undo send" use. A held submission
records account, identity, recipients, the draft's thread and a hash of the draft
MIME in protected SQLite and answers `undoStatus: pending` with `sendAt`; nothing is
sent to Google at that point and the draft stays a native Gmail draft. A worker
(every 5 s) leases due entries atomically and, before calling `drafts.send`,
re-checks composition, the identity (fresh send-as read), the draft's existence
and hash, and the send ledger. A draft edited or deleted in the meantime, a removed
identity, or an entry that comes due while the bridge is down for longer than
`GMAIL_SCHEDULE_LATE_TOLERANCE` (default 900 s) is **suspended**, never sent: the
submission becomes final with a per-recipient `deliveryStatus` explaining why and the
draft remains in Drafts to be sent again by hand. Transient Google errors before the
send call leave the entry pending for the next tick, and so does a send Google
refused for authorization or rate-limit reasons; a send Google rejects outright is
suspended.

`EmailSubmission/set` `update: {id: {undoStatus: "canceled"}}` cancels a pending
entry atomically (`cannotUnsend` once it is being handed to Google or already
final); `EmailSubmission/query` lists newest first. Bulwark's reschedule creates
the replacement before cancelling the original, so several pending entries for one
draft are allowed: the first to send wins and the others end up `canceled`
(superseded). An unconfirmed `drafts.send` marks the entry uncertain (final,
`delivered: unknown`) and blocks any further send of that draft, exactly like
immediate sends. Entries found in `sending` after a restart are reconciled through
the ledger: sent, uncertain when `drafts.send` was already in flight, and otherwise
back to pending (the late tolerance still applies). `onSuccessUpdateEmail` filing patches on a held
submission answer `forbidden` in the implicit `Email/set`: Gmail files the message
when it is actually sent. `/healthz` exposes per-status queue counters and nothing
else.

Without the flag, only immediate sends are supported (`maxDelayedSend=0`): no delayed send, undo,
custom SMTP envelope recipients/sender, SMTP parameters, delivery reports or
post-send deletion. Explicit envelopes must match the MIME recipients and account
sender. Submission/get exposes the most recent 100 successful bridge submissions;
no incremental submission changes are implemented. Sent draft IDs cannot be
discarded through the draft-delete path; a draft whose send outcome is uncertain can.

### Incremental sync and recovery

The Gmail backend reads `users.history.list` when the observed profile history
advances. It commits the cursor only after all pages have been read, invalidates
changed message/thread caches, and retains unchanged message bodies and attachment
bytes. The cursor is stored in SQLite and survives process restarts. Google history
expiry triggers cache reset and on-demand reload of the currently viewed mail;
there is no full-account body download. History work is bounded to 100 pages / 50,000
records; larger gaps use the same reload path.

`Email/changes` returns coalesced created/updated/destroyed IDs, including stable
sent-draft aliases. `Mailbox/changes` compares the last 32 persisted snapshots,
including counts and label renames. Unknown/expired states or changes exceeding the
caller's `maxChanges` return `cannotCalculateChanges`; the client reloads the current
view. `Thread/changes` and `Email/queryChanges` still fall back to requery. Without
push configured (see below), sync is triggered by client requests/polling (profile
cache up to 30 seconds). Direct bridge writes still invalidate the account cache conservatively.

Transient read network errors receive bounded retries; writes never automatically
retry. Revoked/expired grants return a sanitized reconnect instruction, without
exposing Google tokens or upstream errors. Uncertain sends explicitly instruct the
user to check Sent and leave the durable submission intent in place across restarts.
Reply composition resolves the parent Message-ID in the same account and supplies
Gmail's native thread ID only when the parent header and normalized subject match.

### Push notifications (Cloud Pub/Sub)

Set `GMAIL_PUSH_TOPIC=projects/<project>/topics/<topic>` to replace polling with Gmail
push; it also works with read-only consent. One-time Google Cloud setup, in the
project that owns the OAuth client: enable the Pub/Sub API, create the topic, grant
`roles/pubsub.publisher` on it to `gmail-api-push@system.gserviceaccount.com`, and
create a **push** subscription for `https://<PUBLIC_URL>/gmail/push` (expose that path
through your reverse proxy). Authenticate the subscription in one of two ways:

- **Authenticated push (recommended):** enable authentication on the subscription with
  a service account, set `GMAIL_PUSH_AUDIENCE` to the subscription's audience (the
  endpoint URL unless you chose another) and `GMAIL_PUSH_SERVICE_ACCOUNT` to that
  service account's email. Every request must then carry a Google-signed OIDC token for
  that account, and no secret appears in URLs or access logs.
- **Shared token:** set a random `GMAIL_PUSH_TOKEN` (24+ characters) and use
  `https://<PUBLIC_URL>/gmail/push?token=<GMAIL_PUSH_TOKEN>` as the endpoint. The bridge
  never logs the query string, but a reverse proxy may, so keep its access logs private.

The bridge calls `users.watch` for every connected account at startup and re-issues it
every 24 h (Google expires watches after 7 days); failures are counted and retried
hourly.

Each notification is authenticated, persisted before it is acknowledged, and coalesced per account (1.5 s) into one run of the
existing incremental engine. Duplicates and out-of-order deliveries are harmless:
the engine always starts from the persisted history cursor. With push configured
the session advertises `eventSourceUrl`; `GET /jmap/eventsource` streams RFC 8620
`StateChange` events (Email/Thread/Mailbox states) after a sync actually changed
something, so open clients update without polling. Accounts with open streams are
also re-synced every 5 minutes as a safety net for notifications Google delays or
drops. `/healthz` reports watches, renewal failures, notification counts and open
streams; addresses and message contents are never logged.


With push configured the backend also accepts `PushSubscription/get` and
`PushSubscription/set` (RFC 8620 §7.2), which is what a webmail needs for system
notifications while every tab is closed. A subscription must use an `https` URL
(typically a push relay that forwards to the browser's push service); the bridge
POSTs a `PushVerification` to it on create and only delivers once the client
returns that code through an update. Expiry defaults to 90 days and is capped at
a year, at most 20 subscriptions per account, and `keys` are accepted but never
stored or echoed back. Deliveries carry `StateChange` for the subscribed types
only; `EmailDelivery` fires exclusively for genuine arrivals, so label changes,
sends, drafts and anything Gmail files into Spam or Trash stay silent. When a
history record omits labels the bridge asks Gmail rather than guess. Endpoints
answering 404/410, or failing eight times in a row, are dropped.

`Mailbox/query` accepts the standard filters (`role`, `hasAnyRole`, `name`,
`parentId`, `isSubscribed`) so a client can resolve the Inbox by role. Webmails
do this when building a notification preview; rejecting the filter reads to them
as "this account has no Inbox" and silences notifications.
Ordinary newest-first folder pages list by label id, use exact label/profile counts
and fetch only the required ID pages. Searches, oldest-first ordering, anchors and
collapsed thread queries enumerate matching IDs before slicing, which can be slow on
large accounts. Gmail's estimated search total is never returned as an exact total.
Profiles refresh after 30 seconds, label details after at most 60 seconds; cached
queries are keyed by observed history state. Gmail does not provide a transactional
snapshot across pages, so concurrent mailbox changes can still affect pagination.

Email IDs are stable across labels. The synthetic `All mail` mailbox includes
**spam and trash**, matching the account-wide profile counts. Label names are
flat. Gmail's unread, starred, important and Chat labels are not listed as mailboxes
(the `$seen`, `$flagged` and `$important` keywords carry them); system labels get
readable names, and labels hidden in Gmail's label list are unsubscribed. Only
`receivedAt` sorting is accepted, using Gmail's native list order (or its reverse);
strict timestamp ordering is not guaranteed by the list API. Supported search
conditions are `inMailbox`, `inMailboxOtherThan` (treated as "in none of these",
because every message is also in All mail), the four standard mapped keywords,
address fields, subject, free text (every word must match; quoted phrases stay
phrases), dates, sizes and attachment presence, combined with AND/OR/NOT. Searches
inherit Gmail token matching and date granularity; other conditions are rejected.
Header/body projections and on-demand MIME part downloads are supported; downloads
are capped at 50 MB. Email/get calls that ask only for header-derived properties use
Gmail's lighter metadata format, and Thread/get fetches up to four threads at once.
The gateway limits each account to four concurrent Google requests and budgets
4,800 quota units/minute using the [current method costs](https://developers.google.com/workspace/gmail/api/reference/quota).

For a proxy behind a reverse proxy on the same host, `LISTEN_HOST=127.0.0.1`
restricts the HTTP listener to loopback (the default remains `0.0.0.0`).

Google setup references: [OAuth web flow](https://developers.google.com/identity/protocols/oauth2/web-server),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

### TLS

The proxy only speaks plain HTTP. Put Caddy, Traefik, or nginx in front of it
and set `PUBLIC_URL` to whatever URL clients see. The Session resource bakes
URLs from `PUBLIC_URL` into `apiUrl`, `downloadUrl`, `uploadUrl`, and
`eventSourceUrl`, so a wrong value silently breaks every client.

## Configuration

| env var                    | default                            | notes                                                |
| -------------------------- | ---------------------------------- | ---------------------------------------------------- |
| `PORT`                     | `8080`                             | HTTP listen port                                     |
| `PUBLIC_URL`               | `http://localhost:$PORT`           | URL clients see; baked into the Session resource     |
| `DATA_DIR`                 | `./data` (or `/data` in Docker)    | SQLite database, vault entries, upload bodies        |
| `VAULT_KEY`                | required                           | base64 of 32 bytes; AES-256-GCM credential vault     |
| `SESSION_HMAC_KEY`         | required                           | base64 of 32 bytes; HMAC-SHA-256 over session tokens |
| `DEFAULT_PROVIDER`         | `generic`                          | provider key when `/api/login` omits one             |
| `PROVIDERS_FILE`           | `/etc/legacy-proxy/providers.json` | provider catalogue                                   |
| `LOG_LEVEL`                | `info`                             | pino level                                           |
| `MAX_CONCURRENT_REQUESTS`  | `10`                               | advertised on `coreCapabilityProps`                  |
| `MAX_OBJECTS_IN_GET`       | `500`                              | advertised on `coreCapabilityProps`                  |
| `MAX_OBJECTS_IN_SET`       | `500`                              | advertised on `coreCapabilityProps`                  |
| `MAX_SIZE_UPLOAD`          | `50_000_000` (50 MB)               | upload endpoint body limit, advertised in caps       |
| `MAX_SIZE_REQUEST`         | `10_000_000` (10 MB)               | JMAP POST body limit, advertised in caps             |
| `MAX_CALLS_IN_REQUEST`     | `64`                               | per-envelope method-call cap                         |
| `JMAP_DEBUG`               | unset                              | set to `1` to log every request/response shape       |

`providers.example.json` ships entries for Gmail and a generic
`$IMAP_HOST` / `$SMTP_HOST` / `$SIEVE_HOST` / `$CARDDAV_HOST` template.
A `null` for any of `sieve` or `carddav` is allowed; the corresponding JMAP
methods will then either return empty results or, for vacation, reject with
the underlying ManageSieve error. An optional `domains` array on a provider
opts it into domain-based [provider selection](#provider-selection);
`providers.two-servers.example.json` shows two providers wired up that way.

## Tests

```bash
npm test                  # unit tests (vitest)
npm run test:integration  # vitest, gated by RUN_INTEGRATION=1; requires compose.test.yml
npm run test:compliance   # jmapio/jmap-test-suite against a live proxy
npm run test:all
```

The integration compose stack runs Stalwart locally on non-default ports and
points the proxy at it.

`test:compliance` clones [jmap-test-suite](https://github.com/jmapio/jmap-test-suite)
into `vendor/jmap-test-suite/`, generates a `config.local.json` from
`PROXY_URL` + `JMAP_USER_PRIMARY` / `JMAP_PASS_PRIMARY` (and an optional
secondary user), runs it, then triages the report against
`test/compliance/known-failures.txt`. Anything failing outside the allowlist
is treated as a regression.

## Architecture

```
src/
  server.ts        fastify bootstrap, auth, upload/download/eventsource routes
  backends/        legacy transport bindings for authenticated JMAP requests
  jmap/            session, router, capabilities, errors, refs, eventsource hub
    methods/       per-type handlers (mailbox, email, threads, identity,
                   submission, vacation, contacts, push)
  imap/            imapflow client/pool, fetcher, search compiler, header parsing
  smtp/            nodemailer submission
  sieve/           ManageSieve client, vacation script generator
  carddav/         CardDAV client + vCard / JSContact translation
  push/            PushDispatcher (SSE + relay fan-out), PushIdleManager
  auth/            session tokens, AES-256-GCM credential vault, providers
  mapping/         IMAP <-> JMAP id/blobId codecs, flag map, body structure,
                   MIME builder
  state/           SQLite store, opaque state strings, change log
  util/            config loader, pino log
```

The JMAP dispatcher accepts a request-bound method table, a call limit, and
an opaque session state. `backends/legacy.ts` binds the existing handlers to
the authenticated account and its IMAP/SMTP/ManageSieve/CardDAV resources;
`server.ts` selects that table for each request. The dispatcher owns result
references, capability gates, mutation barriers, and response ordering without
importing a mail transport or the account store.

This is a method-dispatch boundary only. Login, session capabilities, blob
routes, and IDLE are still wired to the legacy backend in `server.ts`. Adding
another backend also requires adapting those entry points; a new method table
alone does not enable a provider. The existing `gmail` provider still uses IMAP.

## License

AGPL-3.0
