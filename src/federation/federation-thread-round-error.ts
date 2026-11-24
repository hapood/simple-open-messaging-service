/** A queue is running a message direction the source does not use. */
export class FederationThreadRoundDirectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FederationThreadRoundDirectionError';
  }
}

/** Stops a stale round from committing after the thread's authorization changes. */
export class FederationThreadRoundAuthorizationEpochChangedError extends Error {
  constructor() {
    super('federation round authorization epoch changed');
    this.name = 'FederationThreadRoundAuthorizationEpochChangedError';
  }
}

/** Carries the authorization epoch frozen before one thread-round network request. */
export class FederationThreadRoundRemoteError extends Error {
  constructor(
    readonly remoteCause: unknown,
    readonly authorizationEpoch: number,
  ) {
    super(
      remoteCause instanceof Error
        ? remoteCause.message
        : 'federation thread round network request failed',
      { cause: remoteCause },
    );
    this.name = 'FederationThreadRoundRemoteError';
  }
}
