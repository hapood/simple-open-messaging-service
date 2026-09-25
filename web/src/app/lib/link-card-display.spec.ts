import { linkCardHost, linkCardSource } from './link-card-display';

describe('link-card display formatting', () => {
  it('shows the scheme when a target has no hostname', () => {
    expect(linkCardHost('mailto:alice@example.com')).toBe('mailto');
  });
  it('normalizes www in URL host and hostname-shaped site names', () => {
    expect(linkCardHost('https://www.zhihu.com/question/1')).toBe('zhihu.com');
    expect(
      linkCardSource('https://www.zhihu.com/question/1', 'www.zhihu.com'),
    ).toBe('zhihu.com');
  });

  it('preserves a human-readable site name', () => {
    expect(linkCardSource('https://www.zhihu.com/question/1', '知乎')).toBe(
      '知乎',
    );
  });
});
