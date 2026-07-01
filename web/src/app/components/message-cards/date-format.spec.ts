import dayjs from 'dayjs';
import { formatDateSeparator, sameDay, shouldShowDateSeparator } from './date-format';

/**
 * date-format 单测：跨日判定 + 文案分级。
 *
 * sameDay/shouldShowDateSeparator 只比较入参时间戳（不依赖「现在」）→ 稳定。
 * formatDateSeparator 内部用 dayjs()=现在做相对分级 → 用相对 now 的偏移构造场景。
 */
describe('date-format', () => {
  describe('sameDay', () => {
    it('同日（同一天的起止）→ true', () => {
      const d = dayjs();
      expect(sameDay(d.startOf('day').valueOf(), d.endOf('day').valueOf())).toBe(true);
    });
    it('跨日 → false', () => {
      const d = dayjs();
      expect(sameDay(d.valueOf(), d.add(1, 'day').valueOf())).toBe(false);
    });
    it('跨年同月日 → false', () => {
      const d = dayjs();
      expect(sameDay(d.valueOf(), d.subtract(1, 'year').valueOf())).toBe(false);
    });
  });

  describe('shouldShowDateSeparator', () => {
    const d = () => dayjs();
    it('prev 同天 → false', () => {
      expect(shouldShowDateSeparator(d().startOf('day').valueOf(), d().endOf('day').valueOf(), false)).toBe(false);
    });
    it('prev 跨天 → true（覆盖批次内/批次边界跨日）', () => {
      expect(shouldShowDateSeparator(d().subtract(1, 'day').valueOf(), d().valueOf(), false)).toBe(true);
    });
    it('prev==null + oldest → true（对话首条上方固定 date）', () => {
      expect(shouldShowDateSeparator(null, d().valueOf(), true)).toBe(true);
    });
    it('prev==null + 非 oldest → false（trim 重挂不误显，防 date pill 闪烁）', () => {
      expect(shouldShowDateSeparator(null, d().valueOf(), false)).toBe(false);
    });
    it('prev 跨天时 oldest 标记不影响结果（仍 true）', () => {
      expect(shouldShowDateSeparator(d().subtract(1, 'day').valueOf(), d().valueOf(), true)).toBe(true);
    });
  });

  describe('formatDateSeparator', () => {
    const day = 86_400_000;
    it('today', () => { expect(formatDateSeparator(Date.now())).toBe('Today'); });
    it('yesterday', () => { expect(formatDateSeparator(Date.now() - day)).toBe('Yesterday'); });
    it('within this week (3 days ago) → weekday name', () => {
      expect(formatDateSeparator(Date.now() - 3 * day)).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/);
    });
    it('earlier this year (100 days ago) → MMM D', () => {
      expect(formatDateSeparator(Date.now() - 100 * day)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    });
    it('other year (800 days ago) → MMM D, YYYY', () => {
      expect(formatDateSeparator(Date.now() - 800 * day)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    });
  });
});
