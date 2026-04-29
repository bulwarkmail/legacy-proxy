// Translate IMAP BODYSTRUCTURE (as parsed by imapflow) into the RFC 8621
// EmailBodyPart shape, and pick textBody/htmlBody/attachments per §4.1.4.

export interface EmailBodyPart {
  partId: string | null;
  blobId: string | null;
  size: number;
  headers: { name: string; value: string }[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language: string[] | null;
  location: string | null;
  subParts: EmailBodyPart[] | null;
}

interface ImapflowPart {
  part?: string;
  type?: string;
  parameters?: Record<string, string>;
  id?: string | null;
  description?: string | null;
  encoding?: string | null;
  size?: number;
  disposition?: string | null;
  dispositionParameters?: Record<string, string> | null;
  language?: string[] | null;
  location?: string | null;
  childNodes?: ImapflowPart[] | null;
}

function paramName(parameters: Record<string, string> | undefined, dispParams: Record<string, string> | null | undefined): string | null {
  if (dispParams?.filename) return dispParams.filename;
  if (parameters?.name) return parameters.name;
  return null;
}

export function structureToBodyParts(
  root: ImapflowPart,
  blobIdFor: (partId: string | null) => string | null,
): EmailBodyPart {
  function walk(p: ImapflowPart, fallbackPartId: string | null): EmailBodyPart {
    const isMulti = (p.type ?? "").toLowerCase().startsWith("multipart/");
    // imapflow omits `.part` for single-part messages; IMAP convention is "1".
    const partId = p.part ?? fallbackPartId ?? null;
    const children = p.childNodes
      ? p.childNodes.map((child, i) => walk(child, partId ? `${partId}.${i + 1}` : `${i + 1}`))
      : null;
    return {
      partId: isMulti ? null : partId,
      blobId: isMulti ? null : blobIdFor(partId),
      size: p.size ?? 0,
      headers: [],
      name: paramName(p.parameters, p.dispositionParameters ?? null),
      type: (p.type ?? "application/octet-stream").toLowerCase(),
      charset: p.parameters?.charset?.toLowerCase() ?? null,
      disposition: p.disposition ? p.disposition.toLowerCase() : null,
      cid: p.id ? p.id.replace(/^<|>$/g, "") : null,
      language: p.language && p.language.length ? p.language : null,
      location: p.location ?? null,
      subParts: children,
    };
  }
  return walk(root, "1");
}

export interface SelectedBodies {
  textBody: EmailBodyPart[];
  htmlBody: EmailBodyPart[];
  attachments: EmailBodyPart[];
  hasAttachment: boolean;
}

// Implements RFC 8621 §4.1.4 selection algorithm.
export function selectBodies(root: EmailBodyPart): SelectedBodies {
  const textBody: EmailBodyPart[] = [];
  const htmlBody: EmailBodyPart[] = [];
  const attachments: EmailBodyPart[] = [];

  function walk(node: EmailBodyPart, multipartType: string | null, inAlternative: boolean): void {
    const ct = node.type;
    if (node.subParts === null) {
      const isAttachment =
        node.disposition === "attachment" ||
        (multipartType !== "alternative" && !ct.startsWith("text/") && !ct.startsWith("multipart/"));
      if (isAttachment) {
        attachments.push(node);
      } else if (ct === "text/plain") {
        textBody.push(node);
        if (inAlternative) {
          // alt: also surface as html (RFC 8621 §4.1.4 chooses the matching one)
        }
      } else if (ct === "text/html") {
        htmlBody.push(node);
      } else if (ct.startsWith("text/")) {
        textBody.push(node);
        htmlBody.push(node);
      }
      return;
    }
    const sub = ct.replace(/^multipart\//, "");
    if (sub === "alternative") {
      const plain = node.subParts.find((p) => p.type === "text/plain") ?? null;
      const html = node.subParts.find((p) => p.type === "text/html") ?? null;
      if (plain) walk(plain, sub, true);
      if (html) walk(html, sub, true);
      for (const child of node.subParts) {
        if (child !== plain && child !== html) walk(child, sub, true);
      }
      return;
    }
    for (const child of node.subParts) walk(child, sub, false);
  }

  walk(root, null, false);
  return {
    textBody,
    htmlBody,
    attachments,
    hasAttachment: attachments.length > 0,
  };
}
