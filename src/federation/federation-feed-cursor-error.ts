export class RemoteFeedCursorUnavailableError extends Error {
  constructor(
    public readonly resumeAfter: bigint,
    public readonly resumeBefore: bigint,
  ) {
    super('remote feed cursor is unavailable');
    this.name = 'RemoteFeedCursorUnavailableError';
  }
}

export class RemoteMessageCursorUnavailableError extends Error {
  constructor(
    public readonly resumeAfter: number,
    public readonly resumeBefore: number,
  ) {
    super('remote message cursor is unavailable');
    this.name = 'RemoteMessageCursorUnavailableError';
  }
}
