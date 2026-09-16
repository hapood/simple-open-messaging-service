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

/** A failed S2S HTTP response or an HTTP 200 business result. */
export class S2sResponseError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly data?: unknown;
  federationVersion?: number;

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
