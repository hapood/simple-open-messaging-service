import { describe, expect, it } from 'vitest';
import { selectHistoryEdges } from './history-edge-slots';

const row = (id: number, flags = {}) => ({
  id,
  optimistic: false,
  transient: false,
  ...flags,
});
const history = (entry: { id: number }) => entry.id > 0;

describe('history edge slots', () => {
  it('has no slots for empty or pending-only windows', () => {
    expect(selectHistoryEdges([], history)).toEqual({
      older: null,
      newer: null,
    });
    expect(
      selectHistoryEdges(
        [row(1, { optimistic: true }), row(2, { transient: true })],
        history,
      ),
    ).toEqual({ older: null, newer: null });
  });

  it('shares one identity when a single formal row occupies both edges', () => {
    const entry = row(1);
    expect(selectHistoryEdges([entry], history)).toEqual({
      older: entry,
      newer: entry,
    });
  });

  it('skips separators and pending at either edge', () => {
    const older = row(10);
    const newer = row(20);
    expect(
      selectHistoryEdges(
        [
          row(-1),
          row(1, { transient: true }),
          older,
          row(15),
          newer,
          row(22, { optimistic: true }),
        ],
        history,
      ),
    ).toEqual({ older, newer });
  });
});
