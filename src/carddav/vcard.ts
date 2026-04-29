// vCard 3.0 / 4.0 parser → JSContact (RFC 9553) projection used by JMAP for
// Contacts (RFC 9610). We don't aim for full fidelity - we cover the
// properties webmail actually displays: FN, N, EMAIL, TEL, ORG, TITLE, ADR,
// NOTE, URL, BDAY, NICKNAME, KIND, UID, REV.

export interface JsContact {
  uid: string;
  kind?: "individual" | "group" | "org" | "location" | "device" | "application";
  name?: {
    full?: string;
    components?: Array<{
      kind:
        | "given"
        | "surname"
        | "prefix"
        | "suffix"
        | "additional"
        | "separator"
        | "credential"
        | "title"
        | "middle"
        | "given2"
        | "surname2"
        | "generation";
      value: string;
    }>;
  };
  nicknames?: Record<string, { name: string }>;
  emails?: Record<string, { address: string; contexts?: Record<string, boolean>; pref?: number }>;
  phones?: Record<string, { number: string; contexts?: Record<string, boolean>; features?: Record<string, boolean>; pref?: number }>;
  organizations?: Record<string, { name?: string; units?: Array<{ name: string }> }>;
  titles?: Record<string, { name: string; kind?: "title" | "role" }>;
  addresses?: Record<
    string,
    {
      components?: Array<{ kind: string; value: string }>;
      full?: string;
      contexts?: Record<string, boolean>;
      // Flat fields kept for the webmail UI's legacy reader.
      street?: string;
      locality?: string;
      region?: string;
      postcode?: string;
      country?: string;
    }
  >;
  notes?: Record<string, { note: string }>;
  links?: Record<string, { uri: string; kind?: "contact" | "generic" }>;
  anniversaries?: Record<string, { kind: "birth" | "death" | "wedding" | "other"; date: string }>;
  updated?: string;
  prodId?: string;
}

interface ParsedLine {
  name: string;
  params: Record<string, string[]>;
  value: string;
}

/**
 * Parse a vCard 3.0/4.0 text body. Returns one JsContact per `BEGIN:VCARD` /
 * `END:VCARD` block. Tolerant of folded lines (RFC 6350 §3.2), unknown
 * properties, and non-ASCII content.
 */
export function parseVCards(text: string): JsContact[] {
  const lines = unfold(text).split(/\r?\n/);
  const out: JsContact[] = [];
  let current: ParsedLine[] | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VCARD") {
      current = [];
      continue;
    }
    if (upper === "END:VCARD") {
      if (current) out.push(toJsContact(current));
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseLine(line);
    if (parsed) current.push(parsed);
  }
  return out;
}

function unfold(text: string): string {
  // RFC 6350 §3.2: a line wrapped at 75 octets is folded by inserting CRLF
  // followed by a single whitespace. To unfold, drop those join points.
  return text.replace(/\r?\n[ \t]/g, "");
}

function parseLine(line: string): ParsedLine | null {
  // Property syntax:  GROUP.NAME;PARAM=val;PARAM=val:value
  // Values can contain ":" if escaped or inside quoted parameters; we look
  // for the first unquoted ":".
  let i = 0;
  let inQuote = false;
  let colonIdx = -1;
  for (; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx < 0) return null;

  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const segs = splitUnquoted(head, ";");
  if (segs.length === 0) return null;
  const namePart = segs[0];
  if (!namePart) return null;
  const dot = namePart.indexOf(".");
  const name = (dot >= 0 ? namePart.slice(dot + 1) : namePart).toUpperCase();

  const params: Record<string, string[]> = {};
  for (let s = 1; s < segs.length; s++) {
    const seg = segs[s]!;
    const eq = seg.indexOf("=");
    if (eq < 0) {
      // vCard 2.1 bare type, e.g. "HOME"
      const upper = seg.toUpperCase();
      params["TYPE"] = (params["TYPE"] ?? []).concat(upper);
      continue;
    }
    const k = seg.slice(0, eq).toUpperCase();
    const v = seg.slice(eq + 1);
    const values = splitUnquoted(v, ",").map((x) => stripQuotes(x).toUpperCase());
    params[k] = (params[k] ?? []).concat(values);
  }
  return { name, params, value };
}

function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
    } else if (ch === sep && !inQuote) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

function stripQuotes(s: string): string {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

function unescapeValue(v: string): string {
  return v.replace(/\\([nN,;:\\])/g, (_m, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

function toJsContact(props: ParsedLine[]): JsContact {
  const c: JsContact = { uid: "" };
  const emailIdxByCount: { i: number } = { i: 0 };
  const phoneIdxByCount: { i: number } = { i: 0 };
  const orgIdxByCount: { i: number } = { i: 0 };
  const titleIdxByCount: { i: number } = { i: 0 };
  const adrIdxByCount: { i: number } = { i: 0 };
  const noteIdxByCount: { i: number } = { i: 0 };
  const linkIdxByCount: { i: number } = { i: 0 };
  const nickIdxByCount: { i: number } = { i: 0 };

  for (const p of props) {
    switch (p.name) {
      case "VERSION":
        break;
      case "UID":
        c.uid = unescapeValue(p.value);
        break;
      case "FN": {
        const v = unescapeValue(p.value);
        c.name = c.name ?? {};
        c.name.full = v;
        break;
      }
      case "N": {
        // surname;given;additional;prefix;suffix
        const parts = splitUnquoted(p.value, ";").map(unescapeValue);
        const components: Array<{ kind: "given" | "surname" | "additional" | "prefix" | "suffix"; value: string }> = [];
        const map: Array<{ kind: "given" | "surname" | "additional" | "prefix" | "suffix"; idx: number }> = [
          { kind: "surname", idx: 0 },
          { kind: "given", idx: 1 },
          { kind: "additional", idx: 2 },
          { kind: "prefix", idx: 3 },
          { kind: "suffix", idx: 4 },
        ];
        for (const m of map) {
          const v = parts[m.idx];
          if (v) components.push({ kind: m.kind, value: v });
        }
        if (components.length > 0) {
          c.name = c.name ?? {};
          c.name.components = components;
        }
        break;
      }
      case "NICKNAME": {
        const id = `n${++nickIdxByCount.i}`;
        c.nicknames = c.nicknames ?? {};
        c.nicknames[id] = { name: unescapeValue(p.value) };
        break;
      }
      case "EMAIL": {
        const id = `e${++emailIdxByCount.i}`;
        const types = (p.params["TYPE"] ?? []).map((x) => x.toLowerCase());
        const ctx: Record<string, boolean> = {};
        if (types.includes("home")) ctx["private"] = true;
        if (types.includes("work")) ctx["work"] = true;
        const pref = parseFloat((p.params["PREF"] ?? [])[0] ?? "");
        c.emails = c.emails ?? {};
        c.emails[id] = {
          address: unescapeValue(p.value),
          ...(Object.keys(ctx).length ? { contexts: ctx } : {}),
          ...(Number.isFinite(pref) ? { pref } : {}),
        };
        break;
      }
      case "TEL": {
        const id = `p${++phoneIdxByCount.i}`;
        const types = (p.params["TYPE"] ?? []).map((x) => x.toLowerCase());
        const ctx: Record<string, boolean> = {};
        if (types.includes("home")) ctx["private"] = true;
        if (types.includes("work")) ctx["work"] = true;
        const features: Record<string, boolean> = {};
        if (types.includes("cell") || types.includes("mobile")) features["mobile"] = true;
        if (types.includes("fax")) features["fax"] = true;
        if (types.includes("voice")) features["voice"] = true;
        if (types.includes("text") || types.includes("sms")) features["text"] = true;
        c.phones = c.phones ?? {};
        c.phones[id] = {
          number: unescapeValue(p.value),
          ...(Object.keys(ctx).length ? { contexts: ctx } : {}),
          ...(Object.keys(features).length ? { features } : {}),
        };
        break;
      }
      case "ORG": {
        const id = `o${++orgIdxByCount.i}`;
        const parts = splitUnquoted(p.value, ";").map(unescapeValue).filter(Boolean);
        if (parts.length === 0) break;
        const [name, ...units] = parts;
        c.organizations = c.organizations ?? {};
        c.organizations[id] = {
          ...(name ? { name } : {}),
          ...(units.length ? { units: units.map((u) => ({ name: u })) } : {}),
        };
        break;
      }
      case "TITLE": {
        const id = `t${++titleIdxByCount.i}`;
        c.titles = c.titles ?? {};
        c.titles[id] = { name: unescapeValue(p.value), kind: "title" };
        break;
      }
      case "ROLE": {
        const id = `t${++titleIdxByCount.i}`;
        c.titles = c.titles ?? {};
        c.titles[id] = { name: unescapeValue(p.value), kind: "role" };
        break;
      }
      case "ADR": {
        // pobox;ext;street;locality;region;postcode;country
        const parts = splitUnquoted(p.value, ";").map(unescapeValue);
        const id = `a${++adrIdxByCount.i}`;
        const types = (p.params["TYPE"] ?? []).map((x) => x.toLowerCase());
        const ctx: Record<string, boolean> = {};
        if (types.includes("home")) ctx["private"] = true;
        if (types.includes("work")) ctx["work"] = true;
        const components: Array<{ kind: string; value: string }> = [];
        const street = parts[2] ?? "";
        const locality = parts[3] ?? "";
        const region = parts[4] ?? "";
        const postcode = parts[5] ?? "";
        const country = parts[6] ?? "";
        if (street) components.push({ kind: "name", value: street });
        if (locality) components.push({ kind: "locality", value: locality });
        if (region) components.push({ kind: "region", value: region });
        if (postcode) components.push({ kind: "postcode", value: postcode });
        if (country) components.push({ kind: "country", value: country });
        c.addresses = c.addresses ?? {};
        c.addresses[id] = {
          ...(components.length ? { components } : {}),
          ...(Object.keys(ctx).length ? { contexts: ctx } : {}),
          ...(street ? { street } : {}),
          ...(locality ? { locality } : {}),
          ...(region ? { region } : {}),
          ...(postcode ? { postcode } : {}),
          ...(country ? { country } : {}),
        };
        break;
      }
      case "NOTE": {
        const id = `n${++noteIdxByCount.i}`;
        c.notes = c.notes ?? {};
        c.notes[id] = { note: unescapeValue(p.value) };
        break;
      }
      case "URL": {
        const id = `l${++linkIdxByCount.i}`;
        c.links = c.links ?? {};
        c.links[id] = { uri: unescapeValue(p.value), kind: "generic" };
        break;
      }
      case "BDAY": {
        c.anniversaries = c.anniversaries ?? {};
        c.anniversaries["b1"] = { kind: "birth", date: unescapeValue(p.value) };
        break;
      }
      case "REV":
        c.updated = unescapeValue(p.value);
        break;
      case "PRODID":
        c.prodId = unescapeValue(p.value);
        break;
      case "KIND":
      case "X-ADDRESSBOOKSERVER-KIND": {
        const k = unescapeValue(p.value).toLowerCase();
        if (k === "individual" || k === "group" || k === "org" || k === "location" || k === "device" || k === "application") {
          c.kind = k;
        }
        break;
      }
    }
  }
  if (!c.uid) {
    // Some servers don't include UID. Synthesize a stable one from FN/EMAIL.
    const seed = (c.name?.full ?? "") + "|" + (c.emails ? Object.values(c.emails)[0]?.address ?? "" : "");
    c.uid = `urn:vcard:${hashString(seed)}`;
  }
  c.kind = c.kind ?? "individual";
  return c;
}

function hashString(s: string): string {
  // Tiny non-cryptographic hash; only used to give synthesised UIDs some
  // stability. Real UIDs are taken straight from the vCard.
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
