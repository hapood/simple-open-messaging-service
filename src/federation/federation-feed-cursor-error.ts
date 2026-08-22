export class RemoteFeedCursorUnavailableError extends Error {
  constructor(
    public readonly resumeAfter: bigint,
    public readonly resumeBefore: bigint,
  ) {
    super('remote feed cursor is unavailable');
    this.name = 'RemoteFeedCursorUnavailableError';
  }
}
