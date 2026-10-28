// JMAP for Contacts (RFC 9610) handlers backed by CardDAV (RFC 6352).
// We translate JSContact (RFC 9553) - which is JMAP's native shape - from
// vCards on the server. Reads are live: we hit the CardDAV server on each
// /get and rely on its own caches. Writes go straight through as PUT /
// DELETE on .vcf resources and MKCOL / PROPPATCH / DELETE on collections;
// updates re-serialise the card while carrying over any vCard properties we
// don't model.
//
// IDs are derived from the resource path:
//   - addressBookId  = base64url(href)
//   - contactCardId  = base64url(bookHref + "\n" + resourceHref)
// This keeps them stable across requests as long as the server doesn't
// rename collections.

import crypto from "node:crypto";
import { mapWithConcurrency } from "../../util/concurrency.js";
import { Buffer } from "node:buffer";
import { CardDavClient, CardDavConflict, davOptions, type AddressBookInfo } from "../../carddav/client.js";
import { parseVCards, serializeVCard, type JsContact } from "../../carddav/vcard.js";
import type { Credentials } from "../../auth/credentials.js";
import type { ProviderConfig } from "../../util/config.js";
import type { AccountRow } from "../../state/store.js";
import { accountNotFound, JmapError } from "../errors.js";
import { log } from "../../util/log.js";

export interface ContactCtx {
  account: AccountRow;
  provider: ProviderConfig;
  creds: Credentials;
}

interface AddressBookJson {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  isDefault: boolean;
  isSubscribed: boolean;
  myRights: {
    mayRead: boolean;
    mayWrite: boolean;
    mayAdmin: boolean;
    mayDelete: boolean;
  };
}

interface ContactCardJson extends Omit<JsContact, "uid"> {
  id: string;
  uid: string;
  addressBookIds: Record<string, boolean>;
}

interface Job {
  book: AddressBookInfo;
  hrefs: string[];
  idByHref: Map<string, string>;
}

// How many addressbook-multiget REPORTs to keep in flight. Enough to hide the
// round-trip latency of a large book, low enough that we are not hammering a
// shared DAV server on behalf of one user.
const MULTIGET_CONCURRENCY = 4;

function ensureCardDav(provider: ProviderConfig): NonNullable<ProviderConfig["carddav"]> {
  if (!provider.carddav) {
    throw new JmapError("forbidden", "Contacts are not configured for this provider");
  }
  return provider.carddav;
}

function makeClient(ctx: ContactCtx): CardDavClient {
  return new CardDavClient(davOptions(ensureCardDav(ctx.provider), ctx.creds));
}

function encodeId(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function decodeId(id: string): string {
  return Buffer.from(id, "base64url").toString("utf8");
}

function bookId(href: string): string {
  return encodeId(href);
}

function cardId(bookHref: string, resourceHref: string): string {
  return encodeId(bookHref + "\n" + resourceHref);
}

function splitCardId(id: string): { bookHref: string; resourceHref: string } | null {
  try {
    const decoded = decodeId(id);
    const idx = decoded.indexOf("\n");
    if (idx < 0) return null;
    return { bookHref: decoded.slice(0, idx), resourceHref: decoded.slice(idx + 1) };
  } catch {
    return null;
  }
}

function projectAddressBook(b: AddressBookInfo, isFirst: boolean): AddressBookJson {
  return {
    id: bookId(b.href),
    name: b.displayName,
    description: b.description,
    sortOrder: 0,
    isDefault: isFirst,
    isSubscribed: true,
    myRights: { mayRead: true, mayWrite: true, mayAdmin: false, mayDelete: true },
  };
}

function bookState(b: AddressBookInfo): string {
  // Prefer the server's own ctag/sync-token; otherwise fall back to a hash
  // of the href so the state at least changes when the book identity changes.
  const seed = b.ctag ?? b.href;
  return crypto.createHash("sha1").update(seed).digest("base64url").slice(0, 12);
}

function combinedState(books: AddressBookInfo[]): string {
  const h = crypto.createHash("sha1");
  for (const b of books) h.update(b.href + "\0" + (b.ctag ?? "") + "\0");
  return h.digest("base64url").slice(0, 16);
}

// -- AddressBook/get --------------------------------------------------------

export async function addressBookGet(
  args: { accountId: string; ids: string[] | null },
  ctx: ContactCtx,
): Promise<{ accountId: string; state: string; list: AddressBookJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();

  const client = makeClient(ctx);
  const books = await client.listAddressBooks();
  const projected = books.map((b, i) => projectAddressBook(b, i === 0));
  const list = args.ids ? projected.filter((b) => args.ids!.includes(b.id)) : projected;
  const notFound = args.ids ? args.ids.filter((id) => !projected.some((b) => b.id === id)) : [];
  return { accountId: args.accountId, state: combinedState(books), list, notFound };
}

// -- ContactCard/query ------------------------------------------------------

export async function contactCardQuery(
  args: {
    accountId: string;
    filter?: { inAddressBook?: string; addressBookId?: string };
    position?: number;
    limit?: number;
  },
  ctx: ContactCtx,
): Promise<{
  accountId: string;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  total: number;
  ids: string[];
}> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();

  const client = makeClient(ctx);
  const books = await client.listAddressBooks();
  const wanted = args.filter?.inAddressBook ?? args.filter?.addressBookId;
  const target = wanted
    ? books.filter((b) => bookId(b.href) === wanted)
    : books;

  const ids: string[] = [];
  for (const b of target) {
    const resources = await client.listResources(b.href);
    for (const r of resources) ids.push(cardId(b.href, r.href));
  }

  const position = Math.max(0, args.position ?? 0);
  const limit = args.limit && args.limit > 0 ? args.limit : ids.length;
  const slice = ids.slice(position, position + limit);
  return {
    accountId: args.accountId,
    queryState: combinedState(books),
    canCalculateChanges: false,
    position,
    total: ids.length,
    ids: slice,
  };
}

// -- ContactCard/get --------------------------------------------------------

export async function contactCardGet(
  args: { accountId: string; ids: string[] | null },
  ctx: ContactCtx,
): Promise<{ accountId: string; state: string; list: ContactCardJson[]; notFound: string[] }> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();

  const client = makeClient(ctx);
  const books = await client.listAddressBooks();

  // null/undefined ids → all cards across all books.
  const requestedAll = !args.ids;
  const requested = args.ids ?? [];

  // Group requested ids by their owning book; or, when fetching all, walk
  // each book's resource list.
  const jobs = new Map<string, Job>();

  if (requestedAll) {
    for (const b of books) {
      const resources = await client.listResources(b.href);
      const idByHref = new Map<string, string>();
      const hrefs: string[] = [];
      for (const r of resources) {
        idByHref.set(r.href, cardId(b.href, r.href));
        hrefs.push(r.href);
      }
      jobs.set(b.href, { book: b, hrefs, idByHref });
    }
  } else {
    for (const id of requested) {
      const parts = splitCardId(id);
      if (!parts) continue;
      const book = books.find((b) => b.href === parts.bookHref);
      if (!book) continue;
      let job = jobs.get(book.href);
      if (!job) {
        job = { book, hrefs: [], idByHref: new Map() };
        jobs.set(book.href, job);
      }
      job.hrefs.push(parts.resourceHref);
      job.idByHref.set(parts.resourceHref, id);
    }
  }

  // Multiget in chunks to keep request bodies bounded. The chunks are
  // independent, so issue several at once instead of walking them serially --
  // a 400-card address book is 8 sequential round trips otherwise. Results are
  // consumed in the original chunk order so the response stays deterministic.
  const CHUNK = 50;
  const tasks: Array<{ job: Job; chunk: string[] }> = [];
  for (const job of jobs.values()) {
    for (let i = 0; i < job.hrefs.length; i += CHUNK) {
      tasks.push({ job, chunk: job.hrefs.slice(i, i + CHUNK) });
    }
  }
  const fetched = await mapWithConcurrency(tasks, MULTIGET_CONCURRENCY, (t) =>
    client.multiGet(t.job.book.href, t.chunk),
  );

  const list: ContactCardJson[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < tasks.length; i++) {
    const job = tasks[i]!.job;
    for (const r of fetched[i]!) {
      const cards = parseVCards(r.data);
      const id = job.idByHref.get(r.href) ?? cardId(job.book.href, r.href);
      for (const card of cards) {
        // One vCard resource = one ContactCard. If a server packs more than
        // one VCARD per resource, only the first is exposed under the id.
        const projected: ContactCardJson = {
          ...card,
          id,
          uid: card.uid,
          addressBookIds: { [bookId(job.book.href)]: true },
        };
        if (!seenIds.has(id)) {
          list.push(projected);
          seenIds.add(id);
        }
        break;
      }
    }
  }

  const notFound = requestedAll
    ? []
    : requested.filter((id) => !seenIds.has(id));
  return { accountId: args.accountId, state: combinedState(books), list, notFound };
}

// -- AddressBook/set, ContactCard/set --------------------------------------

/** RFC 8620 §5.3 SetError. */
interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

interface SetArgs {
  accountId: string;
  ifInState?: string | null;
  create?: Record<string, Record<string, unknown>> | null;
  update?: Record<string, Record<string, unknown>> | null;
  destroy?: string[] | null;
}

interface SetResponse<Created> {
  accountId: string;
  oldState: string;
  newState: string;
  created: Record<string, Created> | null;
  updated: Record<string, null> | null;
  destroyed: string[] | null;
  notCreated: Record<string, SetError> | null;
  notUpdated: Record<string, SetError> | null;
  notDestroyed: Record<string, SetError> | null;
}

function setError(type: string, description?: string, properties?: string[]): SetError {
  return { type, ...(description ? { description } : {}), ...(properties ? { properties } : {}) };
}

function errorFor(e: unknown, fallback = "serverFail"): SetError {
  if (e instanceof CardDavConflict) {
    return setError("stateMismatch", "the resource changed on the CardDAV server; refetch and retry");
  }
  if (e instanceof JmapError) return setError(e.type, e.message);
  return setError(fallback, (e as Error)?.message);
}

/**
 * Apply an RFC 8620 §5.3 PatchObject. Keys are JSON-pointer-ish paths
 * (`emails/e1/address`); `null` removes. Top-level keys (`name`, `emails`)
 * replace the whole property, which is what the webmail client sends.
 */
export function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
  for (const [path, value] of Object.entries(patch)) {
    const parts = path.split("/").map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~"));
    if (parts.some((p) => p === "")) throw new JmapError("invalidPatch", `bad path "${path}"`);
    let node: Record<string, unknown> = target;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      const next = node[key];
      if (next == null || typeof next !== "object" || Array.isArray(next)) {
        if (value === null) {
          node = {};
          break;
        }
        const fresh: Record<string, unknown> = {};
        node[key] = fresh;
        node = fresh;
      } else {
        node = next as Record<string, unknown>;
      }
    }
    const leaf = parts[parts.length - 1]!;
    if (value === null || value === undefined) delete node[leaf];
    else node[leaf] = value;
  }
}

/** Fields the server owns or that this backend cannot change post-creation. */
const CARD_IMMUTABLE = new Set(["id", "addressBookIds", "uid"]);

function stripAtType(o: unknown): void {
  // JSContact objects may carry "@type" markers (RFC 9553 §1.3.3); they carry
  // no information for us and would otherwise leak into the patch machinery.
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) {
    for (const x of o) stripAtType(x);
    return;
  }
  const r = o as Record<string, unknown>;
  delete r["@type"];
  for (const v of Object.values(r)) stripAtType(v);
}

/** Pick the (single) address book a card should live in. */
function resolveBook(
  books: AddressBookInfo[],
  addressBookIds: unknown,
): { book: AddressBookInfo } | { error: SetError } {
  if (books.length === 0) {
    return { error: setError("invalidProperties", "no address book exists on the CardDAV server", ["addressBookIds"]) };
  }
  if (addressBookIds == null) return { book: books[0]! };
  if (typeof addressBookIds !== "object") {
    return { error: setError("invalidProperties", "addressBookIds must be an object", ["addressBookIds"]) };
  }
  const ids = Object.entries(addressBookIds as Record<string, unknown>)
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  if (ids.length === 0) return { book: books[0]! };
  if (ids.length > 1) {
    return { error: setError("invalidProperties", "a CardDAV card can only live in one address book", ["addressBookIds"]) };
  }
  const book = books.find((b) => bookId(b.href) === ids[0]);
  if (!book) return { error: setError("invalidProperties", "unknown addressBookId", ["addressBookIds"]) };
  return { book };
}

export async function contactCardSet(
  args: SetArgs,
  ctx: ContactCtx,
): Promise<SetResponse<{ id: string; uid?: string }>> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  let books = await client.listAddressBooks();
  const oldState = combinedState(books);
  if (args.ifInState != null && args.ifInState !== oldState) throw new JmapError("stateMismatch");

  const out: SetResponse<{ id: string; uid?: string }> = {
    accountId: args.accountId,
    oldState,
    newState: oldState,
    created: null,
    updated: null,
    destroyed: null,
    notCreated: null,
    notUpdated: null,
    notDestroyed: null,
  };

  // -- create
  for (const [tempId, raw] of Object.entries(args.create ?? {})) {
    try {
      if (!raw || typeof raw !== "object") throw new JmapError("invalidProperties", "create entry must be an object");
      const input = structuredClone(raw) as Record<string, unknown>;
      stripAtType(input);
      if (books.length === 0 && !hasExplicitBook(input["addressBookIds"])) {
        // A fresh CardDAV account (Radicale in particular) has no
        // collections at all. Clients expect a default book to exist, so
        // materialise one rather than bounce the very first contact.
        books = [await ensureDefaultBook(client)];
      }
      const picked = resolveBook(books, input["addressBookIds"]);
      if ("error" in picked) {
        (out.notCreated ??= {})[tempId] = picked.error;
        continue;
      }
      delete input["addressBookIds"];
      delete input["id"];
      const uid = typeof input["uid"] === "string" && input["uid"] ? (input["uid"] as string) : `urn:uuid:${crypto.randomUUID()}`;
      const card: JsContact = { ...(input as Partial<JsContact>), uid };
      const vcard = serializeVCard(card);
      // Only unreserved characters in the file name so the href the server
      // echoes back in PROPFIND matches what we stored in the id.
      const resourceHref = `${picked.book.href}${crypto.randomUUID()}.vcf`;
      await client.putResource(resourceHref, vcard);
      const id = cardId(picked.book.href, resourceHref);
      (out.created ??= {})[tempId] = { id, ...(input["uid"] === uid ? {} : { uid }) };
    } catch (e) {
      log.warn({ err: (e as Error).message, tempId }, "ContactCard/set create failed");
      (out.notCreated ??= {})[tempId] = errorFor(e, "invalidProperties");
    }
  }

  // -- update
  for (const [id, patch] of Object.entries(args.update ?? {})) {
    try {
      const parts = splitCardId(id);
      const book = parts ? books.find((b) => b.href === parts.bookHref) : undefined;
      if (!parts || !book) {
        (out.notUpdated ??= {})[id] = setError("notFound");
        continue;
      }
      if (!patch || typeof patch !== "object") throw new JmapError("invalidPatch", "update entry must be an object");
      const [existing] = await client.multiGet(book.href, [parts.resourceHref]);
      if (!existing) {
        (out.notUpdated ??= {})[id] = setError("notFound");
        continue;
      }
      const [current] = parseVCards(existing.data);
      if (!current) {
        (out.notUpdated ??= {})[id] = setError("serverFail", "resource is not a vCard");
        continue;
      }
      const cleaned = structuredClone(patch) as Record<string, unknown>;
      stripAtType(cleaned);
      // Tolerate the client echoing immutable fields back unchanged (the
      // webmail form sends the whole card); reject actual changes to them.
      const bad: string[] = [];
      for (const key of Object.keys(cleaned)) {
        const top = key.split("/")[0]!;
        if (!CARD_IMMUTABLE.has(top)) continue;
        const v = cleaned[key];
        const same =
          (top === "id" && v === id) ||
          (top === "uid" && v === current.uid) ||
          (top === "addressBookIds" && key === top && sameBook(v, bookId(book.href)));
        if (!same) bad.push(top);
        delete cleaned[key];
      }
      if (bad.length > 0) {
        (out.notUpdated ??= {})[id] = setError("invalidProperties", `immutable: ${bad.join(", ")}`, bad);
        continue;
      }
      const draft = current as unknown as Record<string, unknown>;
      applyPatch(draft, cleaned);
      const vcard = serializeVCard(draft as unknown as JsContact, { preserveFrom: existing.data });
      await client.putResource(parts.resourceHref, vcard, { ifMatch: existing.etag });
      (out.updated ??= {})[id] = null;
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "ContactCard/set update failed");
      (out.notUpdated ??= {})[id] = errorFor(e, "invalidProperties");
    }
  }

  // -- destroy
  for (const id of args.destroy ?? []) {
    try {
      const parts = splitCardId(id);
      const book = parts ? books.find((b) => b.href === parts.bookHref) : undefined;
      if (!parts || !book) {
        (out.notDestroyed ??= {})[id] = setError("notFound");
        continue;
      }
      await client.deleteResource(parts.resourceHref);
      (out.destroyed ??= []).push(id);
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "ContactCard/set destroy failed");
      (out.notDestroyed ??= {})[id] = errorFor(e);
    }
  }

  if (out.created || out.updated || out.destroyed) {
    books = await client.listAddressBooks();
    out.newState = combinedState(books);
  }
  return out;
}

function hasExplicitBook(addressBookIds: unknown): boolean {
  if (!addressBookIds || typeof addressBookIds !== "object") return false;
  return Object.values(addressBookIds as Record<string, unknown>).some((on) => on === true);
}

const DEFAULT_BOOK_SLUG = "contacts";
const DEFAULT_BOOK_NAME = "Contacts";

/** MKCOL a default address book in the home set and return its info. */
async function ensureDefaultBook(client: CardDavClient): Promise<AddressBookInfo> {
  const home = await client.addressBookHome();
  const href = `${home}${DEFAULT_BOOK_SLUG}/`;
  try {
    await client.makeAddressBook(href, { displayName: DEFAULT_BOOK_NAME });
    log.info({ href }, "created default address book");
  } catch (e) {
    // Lost a race with another request creating it: fine, use it.
    if (!(e instanceof CardDavConflict)) throw e;
  }
  const books = await client.listAddressBooks();
  const created = books.find((b) => b.href === href) ?? books[0];
  if (!created) throw new JmapError("serverFail", "address book creation did not take effect");
  return created;
}

function sameBook(v: unknown, wanted: string): boolean {
  if (!v || typeof v !== "object") return false;
  const on = Object.entries(v as Record<string, unknown>).filter(([, x]) => x === true).map(([k]) => k);
  return on.length === 1 && on[0] === wanted;
}

/** Properties AddressBook/set accepts on create / update. */
const BOOK_WRITABLE = new Set(["name", "description"]);
// Client-side preferences with no CardDAV equivalent; accepted and ignored so
// a rename that happens to carry them along doesn't fail.
const BOOK_IGNORED = new Set(["isSubscribed", "sortOrder", "isDefault", "color"]);

export async function addressBookSet(
  args: SetArgs & { onDestroyRemoveContents?: boolean },
  ctx: ContactCtx,
): Promise<SetResponse<Omit<AddressBookJson, "name">>> {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  let books = await client.listAddressBooks();
  const oldState = combinedState(books);
  if (args.ifInState != null && args.ifInState !== oldState) throw new JmapError("stateMismatch");

  const out: SetResponse<Omit<AddressBookJson, "name">> = {
    accountId: args.accountId,
    oldState,
    newState: oldState,
    created: null,
    updated: null,
    destroyed: null,
    notCreated: null,
    notUpdated: null,
    notDestroyed: null,
  };

  // -- create
  for (const [tempId, raw] of Object.entries(args.create ?? {})) {
    try {
      if (!raw || typeof raw !== "object") throw new JmapError("invalidProperties", "create entry must be an object");
      const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
      if (!name) {
        (out.notCreated ??= {})[tempId] = setError("invalidProperties", "name is required", ["name"]);
        continue;
      }
      const unknown = Object.keys(raw).filter((k) => !BOOK_WRITABLE.has(k) && !BOOK_IGNORED.has(k));
      if (unknown.length > 0) {
        (out.notCreated ??= {})[tempId] = setError("invalidProperties", `unsupported: ${unknown.join(", ")}`, unknown);
        continue;
      }
      const description = typeof raw["description"] === "string" ? raw["description"] : null;
      const home = await client.addressBookHome();
      const href = `${home}${collectionSlug(name, books)}/`;
      await client.makeAddressBook(href, { displayName: name, description });
      const info: AddressBookInfo = { href, displayName: name, description, ctag: null };
      const projected = projectAddressBook(info, books.length === 0);
      const { name: _n, ...serverSet } = projected;
      (out.created ??= {})[tempId] = serverSet;
      books = [...books, info];
    } catch (e) {
      log.warn({ err: (e as Error).message, tempId }, "AddressBook/set create failed");
      (out.notCreated ??= {})[tempId] = errorFor(e, "invalidProperties");
    }
  }

  // -- update
  for (const [id, patch] of Object.entries(args.update ?? {})) {
    try {
      const book = books.find((b) => bookId(b.href) === id);
      if (!book) {
        (out.notUpdated ??= {})[id] = setError("notFound");
        continue;
      }
      if (!patch || typeof patch !== "object") throw new JmapError("invalidPatch", "update entry must be an object");
      const unknown = Object.keys(patch).filter((k) => !BOOK_WRITABLE.has(k) && !BOOK_IGNORED.has(k));
      if (unknown.length > 0) {
        (out.notUpdated ??= {})[id] = setError("invalidProperties", `unsupported: ${unknown.join(", ")}`, unknown);
        continue;
      }
      const props: { displayName?: string; description?: string | null } = {};
      if ("name" in patch) {
        const name = typeof patch["name"] === "string" ? patch["name"].trim() : "";
        if (!name) {
          (out.notUpdated ??= {})[id] = setError("invalidProperties", "name must be a non-empty string", ["name"]);
          continue;
        }
        props.displayName = name;
      }
      if ("description" in patch) {
        const d = patch["description"];
        props.description = typeof d === "string" && d ? d : null;
      }
      await client.updateAddressBookProps(book.href, props);
      (out.updated ??= {})[id] = null;
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "AddressBook/set update failed");
      (out.notUpdated ??= {})[id] = errorFor(e, "invalidProperties");
    }
  }

  // -- destroy
  for (const id of args.destroy ?? []) {
    try {
      const book = books.find((b) => bookId(b.href) === id);
      if (!book) {
        (out.notDestroyed ??= {})[id] = setError("notFound");
        continue;
      }
      if (!args.onDestroyRemoveContents) {
        const contents = await client.listResources(book.href);
        if (contents.length > 0) {
          (out.notDestroyed ??= {})[id] = setError("addressBookHasContents");
          continue;
        }
      }
      await client.deleteResource(book.href);
      (out.destroyed ??= []).push(id);
    } catch (e) {
      log.warn({ err: (e as Error).message, id }, "AddressBook/set destroy failed");
      (out.notDestroyed ??= {})[id] = errorFor(e);
    }
  }

  if (out.created || out.updated || out.destroyed) {
    books = await client.listAddressBooks();
    out.newState = combinedState(books);
  }
  return out;
}

/**
 * Collection name for a new address book: a readable slug when the display
 * name is plain ASCII, otherwise a UUID. Unreserved characters only, so the
 * href the server reports later is byte-identical to the one we built the id
 * from (servers differ in how they percent-encode anything else).
 */
function collectionSlug(name: string, existing: AddressBookInfo[]): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const taken = new Set(existing.map((b) => leaf(b.href)));
  if (slug && !taken.has(slug)) return slug;
  return crypto.randomUUID();
}

function leaf(href: string): string {
  const t = href.replace(/\/+$/, "");
  return t.slice(t.lastIndexOf("/") + 1);
}

// -- *changes / queryChanges -----------------------------------------------

// CardDAV exposes per-collection ctags; we already fold them into the JMAP
// state. Without persistent indexing we can't compute a real diff, so we
// follow the same `cannotCalculateChanges` policy as Email/changes when the
// state has shifted.
export async function addressBookChanges(
  args: { accountId: string; sinceState: string },
  ctx: ContactCtx,
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  const books = await client.listAddressBooks();
  const cur = combinedState(books);
  if (args.sinceState !== cur) throw new JmapError("cannotCalculateChanges");
  return {
    accountId: args.accountId,
    oldState: cur,
    newState: cur,
    hasMoreChanges: false,
    created: [] as string[],
    updated: [] as string[],
    destroyed: [] as string[],
  };
}

export async function contactCardChanges(
  args: { accountId: string; sinceState: string },
  ctx: ContactCtx,
) {
  return addressBookChanges(args, ctx);
}

export async function contactCardQueryChanges(
  args: { accountId: string; sinceQueryState: string },
  ctx: ContactCtx,
) {
  if (args.accountId !== String(ctx.account.id)) throw accountNotFound();
  const client = makeClient(ctx);
  const books = await client.listAddressBooks();
  const cur = combinedState(books);
  if (args.sinceQueryState !== cur) throw new JmapError("cannotCalculateChanges");
  return {
    accountId: args.accountId,
    oldQueryState: cur,
    newQueryState: cur,
    removed: [] as string[],
    added: [] as { id: string; index: number }[],
  };
}

// Used by the session builder to decide whether to advertise the capability.
export function contactsAvailable(provider: ProviderConfig): boolean {
  return provider.carddav != null;
}

// Re-exports for tests.
export const __test = { bookId, cardId, splitCardId, combinedState, bookState };
