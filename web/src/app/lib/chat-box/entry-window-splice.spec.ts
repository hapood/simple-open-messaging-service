import { describe, expect, it } from 'vitest';
import {
  planEntryGapReplacement,
  planEntrySuffix,
} from './entry-window-splice';

type Item = { id: number; messages: number[] };
const message = (id: number): Item => ({ id, messages: [id] });
const identity = (item: Item) => item.id;
const seqs = (item: Item) => item.messages;
const join = (mounted: Item[], response: Item[], read: number) =>
  planEntrySuffix(mounted, response, read, identity, seqs);

describe('entry window splice planning', () => {
  it('marks deliberately skipped history regardless of database coverage', () => {
    const response = [message(101), message(120)];
    expect(join([message(1), message(50)], response, 100)).toEqual({
      additions: response,
      skipped: { after: 50, through: 100 },
    });
  });

  it.each([0, 49, 50])(
    'does not create a gap for R=%s at or before mounted tail',
    (read) => {
      expect(
        join([message(50)], [message(51), message(90)], read).skipped,
      ).toBeUndefined();
    },
  );

  it('numeric holes inside a page alone never create an entry gap', () => {
    expect(
      join([message(50)], [message(51), message(120)], 50).skipped,
    ).toBeUndefined();
  });

  it('deduplicates overlap and uses the delivery-time tail', () => {
    const mounted = [message(50), message(101), message(102)];
    const result = join(
      mounted,
      [message(101), message(102), message(103)],
      100,
    );
    expect(result.additions).toEqual([message(103)]);
    expect(result.skipped).toBeUndefined();
  });

  it('deduplicates messages already represented by a mounted album', () => {
    const album: Item = { id: 101, messages: [101, 102, 103] };
    const result = join(
      [album],
      [message(102), message(103), message(104), message(104)],
      100,
    );
    expect(result.additions).toEqual([message(104)]);
    expect(result.skipped).toBeUndefined();
  });

  it('empty and server-gap-only responses do not manufacture a temporary gap', () => {
    const serverGap: Item = { id: 9000, messages: [] };
    expect(join([message(50)], [], 100).skipped).toBeUndefined();
    expect(join([message(50)], [serverGap], 100)).toEqual({
      additions: [serverGap],
      skipped: undefined,
    });
  });

  it.each([
    { name: 'messages', page: [message(81), message(100)] },
    { name: 'empty', page: [] },
    { name: 'server-gap-only', page: [{ id: 9000, messages: [] }] },
  ])(
    'successful $name gap replacement retains suffix instances and replaces the entire prefix',
    ({ page }) => {
      const suffix = [message(101), message(120)];
      const result = planEntryGapReplacement(suffix, page, identity, seqs);
      expect(result.prepend).toEqual(page);
      expect(result.suffix).toBe(suffix);
      expect(result.suffix[0]).toBe(suffix[0]);
    },
  );

  it('gap replacement deduplicates against delivery-time suffix albums', () => {
    const suffix = [{ id: 101, messages: [101, 102] }];
    const result = planEntryGapReplacement(
      suffix,
      [message(100), message(101), message(102)],
      identity,
      seqs,
    );
    expect(result.prepend).toEqual([message(100)]);
    expect(result.suffix).toBe(suffix);
  });
});
