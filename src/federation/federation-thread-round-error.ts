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
