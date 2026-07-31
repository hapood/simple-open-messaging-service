import { fullyVisibleIndexes } from './chat-box-scroller';

describe('fullyVisibleIndexes', () => {
  it('accounts for flex-end positioning in a short conversation', () => {
    expect(fullyVisibleIndexes([40, 60], 0, 300, 100)).toEqual([0, 1]);
  });

  it('excludes partially visible rows', () => {
    expect(fullyVisibleIndexes([80, 80, 80], 40, 120, 240)).toEqual([1]);
  });

  it('includes exact viewport boundaries', () => {
    expect(fullyVisibleIndexes([50, 50, 50], 50, 100, 150)).toEqual([1, 2]);
  });
});
