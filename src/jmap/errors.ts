// JMAP error envelopes per RFC 8620 §3.6.

export class JmapError extends Error {
  readonly type: string;
  readonly status?: number;
  readonly properties?: Record<string, unknown>;

  constructor(type: string, message?: string, properties?: Record<string, unknown>) {
    super(message ?? type);
    this.type = type;
    this.properties = properties;
  }

  toMethodError(): { type: string; description?: string; [k: string]: unknown } {
    return { type: this.type, description: this.message, ...this.properties };
  }
}

export function unknownMethod(name: string) {
  return new JmapError("unknownMethod", `Unknown method: ${name}`);
}

export function invalidArguments(detail: string) {
  return new JmapError("invalidArguments", detail);
}

export function accountNotFound() {
  return new JmapError("accountNotFound");
}

export function notFound() {
  return new JmapError("notFound");
}

export function cannotCalculateChanges() {
  return new JmapError("cannotCalculateChanges");
}

export function unsupportedFilter(detail: string) {
  return new JmapError("unsupportedFilter", detail);
}

export function unsupportedSort() {
  return new JmapError("unsupportedSort");
}

export function forbidden() {
  return new JmapError("forbidden");
}
