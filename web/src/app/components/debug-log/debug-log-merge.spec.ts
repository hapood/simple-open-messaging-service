import { fromJsEntry, mergeByTs, parseNativeLine, splitLines } from './debug-log-merge';

/**
 * Pure unit (no TestBed, no Tauri) for the debug panel's timestamp parse + interleave. The merge is the
 * one piece of non-trivial logic in the panel, so it gets its own zoneless spec; sample lines mirror the
 * three on-the-wire formats (JS ISO from the ring buffer, Kotlin ISO from `native.log`, Rust bracketed
 * from `tauri-plugin-log`).
 */
describe('debug-log-merge', () => {
  describe('fromJsEntry', () => {
    it('keeps the structured level + parses the ISO ts into epoch ms', () => {
      const line = fromJsEntry({ ts: '2026-07-21T06:23:05.677Z', level: 'warn', text: 'boom' });
      expect(line.source).toBe('js');
      expect(line.level).toBe('warn');
      expect(line.ts).toBe(Date.parse('2026-07-21T06:23:05.677Z'));
      expect(line.text).toBe('boom');
    });
  });

  describe('parseNativeLine (Kotlin native.log format)', () => {
    it('parses the ISO ts, the leading [level], and keeps the [sub] in the text', () => {
      const line = parseNativeLine('2026-07-21T06:23:05.677Z [info] [Rt] openStream url=https://x', 'kotlin');
      expect(line.source).toBe('kotlin');
      expect(line.level).toBe('info');
      expect(line.ts).toBe(Date.parse('2026-07-21T06:23:05.677Z'));
      expect(line.text).toContain('openStream url=https://x');
      expect(line.text).toContain('[Rt]');
    });

    it('maps warn + a thrown cause folded into the message', () => {
      const line = parseNativeLine('2026-07-21T06:23:05.677Z [warn] [Rt] reconnect failed IOException: reset', 'kotlin');
      expect(line.level).toBe('warn');
    });
  });

  describe('parseNativeLine (Rust tauri-plugin-log bracketed format)', () => {
    it('parses the [date][time] prefix (assumed UTC) + a mid-prefix [LEVEL]', () => {
      const line = parseNativeLine('[2026-07-21][06:23:05.677][soms::proxy][INFO] api_request 200', 'rust');
      expect(line.source).toBe('rust');
      expect(line.level).toBe('info');
      expect(line.ts).toBe(Date.parse('2026-07-21T06:23:05.677Z'));
      expect(line.text).toContain('api_request 200');
    });

    it('falls back to info + the raw line when nothing parses', () => {
      const line = parseNativeLine('garbage with no timestamp or level', 'rust');
      expect(line.ts).toBeNull();
      expect(line.level).toBe('info');
      expect(line.text).toContain('garbage');
    });
  });

  describe('mergeByTs', () => {
    it('interleaves by timestamp (ascending) across sources, null-ts lines last', () => {
      const kotlin = parseNativeLine('2026-07-21T06:00:00.000Z [info] [Rt] early', 'kotlin');
      const js = fromJsEntry({ ts: '2026-07-21T07:00:00.000Z', level: 'info', text: 'mid' });
      const rust = parseNativeLine('2026-07-21T08:00:00.000Z [info] [x] late', 'rust');
      const unknown = parseNativeLine('no ts here', 'rust');
      // Feed out of order + the null-ts line first; expect time order with null last.
      const merged = mergeByTs([js, unknown, rust, kotlin]);
      expect(merged.map((l) => l.source)).toEqual(['kotlin', 'js', 'rust', 'rust']);
    });

    it('is stable for equal timestamps (keeps input order)', () => {
      const a = fromJsEntry({ ts: '2026-07-21T06:00:00.000Z', level: 'info', text: 'a' });
      const b = parseNativeLine('2026-07-21T06:00:00.000Z [info] [Rt] b', 'kotlin');
      const merged = mergeByTs([a, b]);
      expect(merged.map((l) => l.source)).toEqual(['js', 'kotlin']);
    });
  });

  describe('splitLines', () => {
    it('splits on newlines and drops a single trailing newline', () => {
      expect(splitLines('a\nb\nc\n')).toEqual(['a', 'b', 'c']);
    });
    it('returns [] for empty / whitespace-only input', () => {
      expect(splitLines('')).toEqual([]);
      expect(splitLines('\n\n')).toEqual([]);
    });
  });
});
