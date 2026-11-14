/**
 * Turns an error string from an upstream provider or the gateway into one plain sentence
 * for the interface, keeping the original for an expandable details block.
 *
 * Providers return JSON bodies such as
 * {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed..."}}
 * which must never be shown raw.
 */
export interface DescribedError {
  summary: string;
  /** The original text, pretty-printed when it was JSON; null when it adds nothing. */
  details: string | null;
  /** The provider's request id, when the body carried one. */
  requestId: string | null;
  /** True when details is the provider's JSON body, offered as "Copy raw" rather than shown. */
  isJson: boolean;
}

const KIND_LABELS: Record<string, string> = {
  rate_limit_error: 'Rate limited',
  rate_limit_exceeded: 'Rate limited',
  usage_limit_reached: 'Usage limit reached',
  overloaded_error: 'Provider overloaded',
  authentication_error: 'Sign-in rejected',
  permission_error: 'Not permitted',
  invalid_request_error: 'Request rejected',
  not_found_error: 'Not found',
  api_error: 'Provider error',
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Find a human message and an error kind anywhere a provider tends to put them. */
const extract = (value: unknown): { message: string; kind: string } => {
  const record = asRecord(value);
  if (!record) return { message: text(value), kind: '' };
  const nested = asRecord(record.error);
  const message =
    text(nested?.message) ||
    text(record.message) ||
    text(record.detail) ||
    text(record.error_description) ||
    (typeof record.error === 'string' ? record.error.trim() : '');
  const kind = text(nested?.type) || text(nested?.code) || text(record.code) || text(record.type);
  return { message, kind: kind === 'error' ? '' : kind };
};

const sentence = (value: string): string => {
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return trimmed;
  const capped = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
};

export function describeError(
  raw: string | null | undefined,
  fallback = 'Something went wrong.'
): DescribedError {
  const original = (raw ?? '').trim();
  if (!original) return { summary: fallback, details: null, requestId: null, isJson: false };

  const jsonStart = original.search(/[{[]/);
  let parsed: unknown = null;
  let prefix = '';
  if (jsonStart >= 0) {
    try {
      parsed = JSON.parse(original.slice(jsonStart));
      prefix = original.slice(0, jsonStart).replace(/[:\s-]+$/, '');
    } catch {
      parsed = null;
    }
  }

  if (parsed !== null) {
    const { message, kind } = extract(parsed);
    const label = KIND_LABELS[kind] ?? '';
    const body = message || prefix || fallback;
    const summary = sentence(
      label && !body.toLowerCase().startsWith(label.toLowerCase()) ? `${label}: ${body}` : body
    );
    const record = asRecord(parsed);
    const requestId =
      text(record?.request_id) ||
      text(record?.requestId) ||
      text(asRecord(record?.error)?.request_id);
    return {
      summary,
      details: JSON.stringify(parsed, null, 2),
      requestId: requestId || null,
      isJson: true,
    };
  }

  // Plain text: keep the first sentence on screen and the rest in details.
  const first = original.match(/^[^.!?\n]{1,220}[.!?]?/)?.[0] ?? original.slice(0, 220);
  const summary = sentence(first);
  return {
    summary,
    details: first.trim().length < original.length ? original : null,
    requestId: null,
    isJson: false,
  };
}
