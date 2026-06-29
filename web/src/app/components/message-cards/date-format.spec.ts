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
    it('今天', () => { expect(formatDateSeparator(Date.now())).toBe('今天'); });
    it('昨天', () => { expect(formatDateSeparator(Date.now() - day)).toBe('昨天'); });
    it('本周内（3 天前）→ 周X', () => {
      expect(formatDateSeparator(Date.now() - 3 * day)).toMatch(/^周[日一二三四五六]$/);
    });
    it('本年更早（100 天前）→ M月D日', () => {
      expect(formatDateSeparator(Date.now() - 100 * day)).toMatch(/^\d{1,2}月\d{1,2}日$/);
    });
    it('跨年（800 天前）→ YYYY年M月D日', () => {
      expect(formatDateSeparator(Date.now() - 800 * day)).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日$/);
    });
  });
});
