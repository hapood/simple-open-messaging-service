/** Best-effort JSON body a peer returns alongside a non-2xx response, with
 * fields narrowed at the parse boundary so callers can trust the types. */
export interface PeerErrorBody {
  code?: number;
  message?: string;
  data?: unknown;
}

/** Normalize any parsed JSON payload — object, `null`, primitive, or absent —
 * into a `PeerErrorBody`; ill-typed or absent fields yield `undefined`. */
export const parsePeerErrorBody = (value: unknown): PeerErrorBody => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  return {
    code: typeof raw.code === 'number' ? raw.code : undefined,
    message: typeof raw.message === 'string' ? raw.message : undefined,
    data: raw.data,
  };
};

/** Strict closed-envelope parse of a peer error body. Returns null unless the
 * body is exactly the common error envelope with a non-zero safe-integer
 * `code` and a string `message`. Only this parse is admissible as evidence for
 * lifecycle decisions such as a fatal hard stop; the lenient parse above
 * stays available for diagnostics on junk bodies. */
export const parseStrictPeerErrorEnvelope = (
  value: unknown,
): { code: number; message: string } | null => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    Object.keys(raw).some((key) => !['code', 'message', 'data'].includes(key))
  ) {
    return null;
  }
  const { code, message } = raw;
  if (
    typeof code !== 'number' ||
    !Number.isSafeInteger(code) ||
    code === 0 ||
    typeof message !== 'string'
  ) {
    return null;
  }
  return { code, message };
};

/** A failed S2S HTTP response or an HTTP 200 business result. */
export class S2sResponseError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, status: number, code?: number, data?: unknown) {
    super(message);
    this.name = 'S2sResponseError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

/** A transport or timeout failure before a valid S2S response was received. */
export class FederationTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FederationTransportError';
  }
}

/** A well-formed feed item whose local relationship/thread context no longer exists. */
export class FederationMessageContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FederationMessageContextError';
  }
}

/** Local membership no longer permits work queued while the source was active. */
export class FederationThreadSourceInactiveError extends FederationMessageContextError {
  constructor(message: string) {
    super(message);
    this.name = 'FederationThreadSourceInactiveError';
  }
}
