export interface FederationBufferedChange {
  changeId: bigint;
  epochId: bigint;
  threadId: number;
  messageId: bigint;
  messageSeq: number;
}

/**
 * Bounded append-only queue split into small arrays. Acknowledgement advances logical head pointers;
 * it never shifts individual entries. Unacknowledged changes are therefore stable for exact retries.
 */
export class FederationChangeBuffer {
  private readonly chunks: FederationBufferedChange[][] = [];
  private headChunk = 0;
  private headOffset = 0;
  private count = 0;
  private lastChangeId: bigint | null = null;

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

  get firstChangeId(): bigint | null {
    return this.peek()?.changeId ?? null;
  }

  get allocatedThrough(): bigint | null {
    return this.lastChangeId;
  }

  append(entry: FederationBufferedChange): boolean {
    if (this.full) return false;
    if (entry.changeId < 0n) throw new Error('changeId must be non-negative');
    if (this.lastChangeId !== null && entry.changeId <= this.lastChangeId) {
      throw new Error('change buffer entries must have increasing change ids');
    }
    let chunk = this.chunks.at(-1);
    if (!chunk || chunk.length >= this.chunkSize) {
      chunk = [];
      this.chunks.push(chunk);
    }
    chunk.push(entry);
    this.count++;
    this.lastChangeId = entry.changeId;
    return true;
  }

  /** Return stable references after a wire cursor without mutating the queue. */
  readAfter(after: bigint, take: number): FederationBufferedChange[] {
    if (!Number.isInteger(take) || take < 0) {
      throw new Error('take must be a non-negative integer');
    }
    if (take === 0 || this.count === 0) return [];
    const result: FederationBufferedChange[] = [];
    this.visit((entry) => {
      if (entry.changeId > after) result.push(entry);
      return result.length < take;
    });
    return result;
  }

  /**
   * Retire and return entries covered by an acknowledged wire cursor. The caller must durably persist
   * their per-thread checkpoints before invoking this method.
   */
  retireThrough(through: bigint): FederationBufferedChange[] {
    const retired: FederationBufferedChange[] = [];
    while (this.count > 0) {
      const chunk = this.chunks[this.headChunk];
      const entry = chunk?.[this.headOffset];
      if (!entry || entry.changeId > through) break;
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
      this.lastChangeId = null;
    }
    return retired;
  }

  snapshot(): FederationBufferedChange[] {
    const result: FederationBufferedChange[] = [];
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
    this.lastChangeId = null;
  }

  private peek(): FederationBufferedChange | undefined {
    return this.chunks[this.headChunk]?.[this.headOffset];
  }

  private visit(visitor: (entry: FederationBufferedChange) => boolean): void {
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
