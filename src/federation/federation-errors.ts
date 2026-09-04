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
