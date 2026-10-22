export class RemoteFeedCursorUnavailableError extends Error {
  constructor(
    public readonly resumeAfter: bigint,
    public readonly resumeBefore: bigint,
  ) {
    super('remote feed cursor is unavailable');
    this.name = 'RemoteFeedCursorUnavailableError';
  }
}

export class RemoteGroupMetaCursorUnavailableError extends Error {
  constructor(
    public readonly resumeAfter: number,
    public readonly resumeBefore: number,
  ) {
    super('remote group-meta cursor is unavailable');
    this.name = 'RemoteGroupMetaCursorUnavailableError';
  }
}
