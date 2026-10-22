const MESSAGE_RANGE_STATES = [
  'LOCAL_COVERED',
  'SERVER_PENDING',
  'SERVER_UNAVAILABLE',
] as const;

type MessageRangeState = (typeof MESSAGE_RANGE_STATES)[number];

export interface MessageInterval {
  left: number;
  right: number;
}

export interface MessageRange extends MessageInterval {
  threadId: number;
  state: MessageRangeState;
}

export interface ServerMessageRange extends MessageInterval {
  state: 'SERVER_PENDING' | 'SERVER_UNAVAILABLE';
}

export interface ReduceMessageRangesInput {
  threadId: number;
  current: readonly MessageRange[];
  scan: MessageInterval | null;
  gaps: readonly ServerMessageRange[];
  messageSeqs: readonly number[];
}

function assertInterval(interval: MessageInterval, label: string): void {
  if (
    !Number.isSafeInteger(interval.left) ||
    !Number.isSafeInteger(interval.right) ||
    interval.left < 0 ||
    interval.right <= interval.left
  )
    throw new Error(
      `invalid ${label} interval (${interval.left},${interval.right}]`,
    );
}

function contains(
  interval: MessageInterval,
  left: number,
  right: number,
): boolean {
  return interval.left <= left && interval.right >= right;
}

function overlaps(a: MessageInterval, b: MessageInterval): boolean {
  return a.left < b.right && a.right > b.left;
}

function validateCurrent(
  threadId: number,
  ranges: readonly MessageRange[],
): void {
  let previous: MessageRange | undefined;
  for (const range of ranges) {
    assertInterval(range, 'stored message range');
    if (range.threadId !== threadId)
      throw new Error('stored message range belongs to another thread');
    if (!MESSAGE_RANGE_STATES.includes(range.state))
      throw new Error(`invalid message range state: ${range.state}`);
    if (previous) {
      if (range.left < previous.right)
        throw new Error('stored message ranges overlap');
      if (range.left === previous.right && range.state === previous.state)
        throw new Error('stored message ranges are not normalized');
    }
    previous = range;
  }
}

function validateResponse(
  scan: MessageInterval | null,
  gaps: readonly ServerMessageRange[],
  messageSeqs: readonly number[],
): void {
  if (scan) assertInterval(scan, 'message scan');
  if (!scan && (gaps.length > 0 || messageSeqs.length > 0))
    throw new Error('an empty message scan cannot contain messages or gaps');

  let previous: ServerMessageRange | undefined;
  for (const gap of gaps) {
    assertInterval(gap, 'server gap');
    if (!scan || !overlaps(gap, scan))
      throw new Error('server gap does not intersect the actual scan');
    if (previous && gap.left < previous.right)
      throw new Error('server gaps overlap');
    previous = gap;
  }

  const seen = new Set<number>();
  for (const seq of messageSeqs) {
    if (!Number.isSafeInteger(seq) || seq <= 0)
      throw new Error(`invalid message sequence: ${seq}`);
    if (seen.has(seq)) throw new Error(`duplicate message sequence: ${seq}`);
    seen.add(seq);
    if (!scan || seq <= scan.left || seq > scan.right)
      throw new Error(`message sequence ${seq} is outside the actual scan`);
    if (gaps.some((gap) => seq > gap.left && seq <= gap.right))
      throw new Error(`message sequence ${seq} overlaps a server gap`);
  }
}

function resolveState(
  current: MessageRangeState | undefined,
  incoming: MessageRangeState | undefined,
): MessageRangeState | undefined {
  if (incoming === undefined) return current;
  if (incoming === 'LOCAL_COVERED') return incoming;
  if (incoming === 'SERVER_PENDING')
    return current === 'LOCAL_COVERED' || current === 'SERVER_UNAVAILABLE'
      ? current
      : incoming;
  return current === 'LOCAL_COVERED' ? current : incoming;
}

/**
 * Reduce one committed HTTP page into the complete canonical range set for a thread.
 * All coordinates are left-open and right-closed. The function is deterministic and
 * intentionally storage-agnostic so browser and native persistence share one state machine.
 */
export function reduceMessageRanges(
  input: ReduceMessageRangesInput,
): MessageRange[] {
  validateCurrent(input.threadId, input.current);
  validateResponse(input.scan, input.gaps, input.messageSeqs);
  if (!input.scan) return input.current.map((range) => ({ ...range }));

  const boundaries = new Set<number>([input.scan.left, input.scan.right]);
  for (const range of input.current) {
    boundaries.add(range.left);
    boundaries.add(range.right);
  }
  for (const gap of input.gaps) {
    boundaries.add(gap.left);
    boundaries.add(gap.right);
  }
  const sorted = [...boundaries].sort((a, b) => a - b);
  const output: MessageRange[] = [];

  for (let index = 0; index < sorted.length - 1; index++) {
    const left = sorted[index]!;
    const right = sorted[index + 1]!;
    if (left === right) continue;
    const current = input.current.find((range) =>
      contains(range, left, right),
    )?.state;
    const returnedGap = input.gaps.find((gap) => contains(gap, left, right));
    const insideScan = contains(input.scan, left, right);
    const incoming =
      returnedGap?.state ?? (insideScan ? 'LOCAL_COVERED' : undefined);
    const state = resolveState(current, incoming);
    if (!state) continue;

    const previous = output.at(-1);
    if (previous && previous.right === left && previous.state === state) {
      previous.right = right;
    } else {
      output.push({ threadId: input.threadId, left, right, state });
    }
  }
  return output;
}
