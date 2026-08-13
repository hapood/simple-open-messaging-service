export interface FederationBufferedChange {
  feedId: bigint;
  threadId: number;
  messageId: bigint;
  messageSeq: number;
}

export interface FederationOrderedChange {
  feedId: bigint;
}

/**
 * Bounded append-only queue split into small arrays. Acknowledgement advances logical head pointers;
 * it never shifts individual entries. Unacknowledged changes are therefore stable for exact retries.
 */
export class FederationChangeBuffer<
  T extends FederationOrderedChange = FederationBufferedChange,
> {
  private readonly chunks: T[][] = [];
  private headChunk = 0;
  private headOffset = 0;
  private count = 0;
  private lastFeedId: bigint | null = null;

  constructor(
    readonly capacity = 10_000,
    readonly chunkSize = 512,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('change buffer capacity must be a positive integer');
    }
    if (!Number.isInteger(chunkSize) || chunkSize < 1) {
      throw new Error('change buffer chunk size must be a positive integer');
    }
  }

  get size(): number {
    return this.count;
  }

  get full(): boolean {
    return this.count >= this.capacity;
  }

  get firstFeedId(): bigint | null {
    return this.peek()?.feedId ?? null;
  }

  get allocatedThrough(): bigint | null {
    return this.lastFeedId;
  }

  append(entry: T): boolean {
    if (this.full) return false;
    if (entry.feedId < 0n) throw new Error('feedId must be non-negative');
    if (this.lastFeedId !== null && entry.feedId <= this.lastFeedId) {
      throw new Error('change buffer entries must have increasing change ids');
    }
    let chunk = this.chunks.at(-1);
    if (!chunk || chunk.length >= this.chunkSize) {
      chunk = [];
      this.chunks.push(chunk);
    }
    chunk.push(entry);
    this.count++;
    this.lastFeedId = entry.feedId;
    return true;
  }

  /** Return stable references after a wire cursor without mutating the queue. */
  readAfter(after: bigint, take: number): T[] {
    if (!Number.isInteger(take) || take < 0) {
      throw new Error('take must be a non-negative integer');
    }
    if (take === 0 || this.count === 0) return [];
    const result: T[] = [];
    this.visit((entry) => {
      if (entry.feedId > after) result.push(entry);
      return result.length < take;
    });
    return result;
  }

  /**
   * Retire and return entries covered by an acknowledged wire cursor. The caller must durably persist
   * their per-thread checkpoints before invoking this method.
   */
  retireThrough(through: bigint): T[] {
    const retired: T[] = [];
    while (this.count > 0) {
      const chunk = this.chunks[this.headChunk];
      const entry = chunk?.[this.headOffset];
      if (!entry || entry.feedId > through) break;
      retired.push(entry);
      this.headOffset++;
      this.count--;
      if (this.headOffset >= chunk.length) {
        this.headChunk++;
        this.headOffset = 0;
      }
    }
    this.compactChunkIndex();
    if (this.count === 0) {
      this.chunks.length = 0;
      this.headChunk = 0;
      this.headOffset = 0;
      this.lastFeedId = null;
    }
    return retired;
  }

  snapshot(): T[] {
    const result: T[] = [];
    this.visit((entry) => {
      result.push(entry);
      return true;
    });
    return result;
  }

  clear(): void {
    this.chunks.length = 0;
    this.headChunk = 0;
    this.headOffset = 0;
    this.count = 0;
    this.lastFeedId = null;
  }

  private peek(): T | undefined {
    return this.chunks[this.headChunk]?.[this.headOffset];
  }

  private visit(visitor: (entry: T) => boolean): void {
    for (
      let chunkIndex = this.headChunk;
      chunkIndex < this.chunks.length;
      chunkIndex++
    ) {
      const chunk = this.chunks[chunkIndex];
      const from = chunkIndex === this.headChunk ? this.headOffset : 0;
      for (let offset = from; offset < chunk.length; offset++) {
        if (!visitor(chunk[offset])) return;
      }
    }
  }

  private compactChunkIndex(): void {
    if (this.headChunk < 32 || this.headChunk * 2 < this.chunks.length) return;
    this.chunks.splice(0, this.headChunk);
    this.headChunk = 0;
  }
}
