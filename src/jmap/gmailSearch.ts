// An account-wide Gmail text search can run once inside All Mail. Every
// message is stored there, and X-GM-RAW uses Gmail's index. A search that
// names a folder stays on that folder. Spam is not in All Mail, so a junk
// keyword is not redirected.

const CONTENT_KEYS = new Set([
  "text",
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "body",
  "header",
  "hasAttachment",
  "before",
  "after",
  "minSize",
  "maxSize",
]);

function leaves(filter: object): object[] | null {
  if (!("operator" in filter)) return [filter];
  const op = filter as { operator?: string; conditions?: object[] };
  if (op.operator !== "AND" || !Array.isArray(op.conditions)) return null;
  const out: object[] = [];
  for (const condition of op.conditions) {
    if (!condition || typeof condition !== "object" || "operator" in condition) return null;
    out.push(condition);
  }
  return out;
}

export function isGmailAccountWideContentSearch(filter: object): boolean {
  const parts = leaves(filter);
  if (!parts || parts.length === 0) return false;
  let content = false;
  for (const condition of parts) {
    for (const [key, value] of Object.entries(condition)) {
      if (value === undefined || value === null || value === "") continue;
      if (key === "inMailbox" || key === "inMailboxOtherThan") return false;
      if (key === "hasKeyword" && value === "$junk") return false;
      if (CONTENT_KEYS.has(key)) content = true;
    }
  }
  return content;
}
