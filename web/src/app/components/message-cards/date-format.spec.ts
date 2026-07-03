import dayjs from 'dayjs';
import { formatDateSeparator, sameDay, shouldShowDateSeparator, type DateTranslator } from './date-format';

/**
 * date-format unit tests: day-change detection + label grading.
 *
 * sameDay / shouldShowDateSeparator only compare their timestamp args (no dependency on "now") → stable.
 * formatDateSeparator grades relative to dayjs() = now → construct scenarios as offsets from now.
 *
 * A fake translator resolves the English "Today"/"Yesterday" keys (dayjs runs with the default 'en' locale
 * here, so weekday and month/day names are English too), keeping the assertions locale-independent.
 */
const en: DateTranslator = {
  translate: (key: string) => (key === 'date.today' ? 'Today' : key === 'date.yesterday' ? 'Yesterday' : key),
};

/**
 * dayjs's locale is process-global; other specs in the suite (e.g. date-row) switch it to zh-cn via
 * LanguageService. Pin it back to 'en' before each test so the weekday / MMM D assertions are stable and
 * independent of test execution order.
 */
beforeEach(() => dayjs.locale('en'));

describe('date-format', () => {
  describe('sameDay', () => {
    it('same day (start and end of one day) → true', () => {
      const d = dayjs();
      expect(sameDay(d.startOf('day').valueOf(), d.endOf('day').valueOf())).toBe(true);
    });
    it('different days → false', () => {
      const d = dayjs();
      expect(sameDay(d.valueOf(), d.add(1, 'day').valueOf())).toBe(false);
    });
    it('same month/day across years → false', () => {
      const d = dayjs();
      expect(sameDay(d.valueOf(), d.subtract(1, 'year').valueOf())).toBe(false);
    });
  });

  describe('shouldShowDateSeparator', () => {
    const d = () => dayjs();
    it('prev same day → false', () => {
      expect(shouldShowDateSeparator(d().startOf('day').valueOf(), d().endOf('day').valueOf(), false)).toBe(false);
    });
    it('prev different day → true (covers in-batch / batch-boundary day change)', () => {
      expect(shouldShowDateSeparator(d().subtract(1, 'day').valueOf(), d().valueOf(), false)).toBe(true);
    });
    it('prev == null + oldest → true (fixed date above the conversation first message)', () => {
      expect(shouldShowDateSeparator(null, d().valueOf(), true)).toBe(true);
    });
    it('prev == null + not oldest → false (trim re-mount must not show a date pill — anti-flicker)', () => {
      expect(shouldShowDateSeparator(null, d().valueOf(), false)).toBe(false);
    });
    it('oldest flag has no effect when prev already crosses a day (still true)', () => {
      expect(shouldShowDateSeparator(d().subtract(1, 'day').valueOf(), d().valueOf(), true)).toBe(true);
    });
  });

  describe('formatDateSeparator', () => {
    const day = 86_400_000;
    it('today', () => { expect(formatDateSeparator(Date.now(), en)).toBe('Today'); });
    it('yesterday', () => { expect(formatDateSeparator(Date.now() - day, en)).toBe('Yesterday'); });
    it('within this week (3 days ago) → weekday name', () => {
      expect(formatDateSeparator(Date.now() - 3 * day, en)).toMatch(/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/);
    });
    it('earlier this year (100 days ago) → MMM D', () => {
      expect(formatDateSeparator(Date.now() - 100 * day, en)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    });
    it('other year (800 days ago) → MMM D, YYYY', () => {
      expect(formatDateSeparator(Date.now() - 800 * day, en)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    });
  });
});
