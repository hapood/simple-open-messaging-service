import { parseForwardCard } from './forward-card';

describe('parseForwardCard', () => {
  it('parses a valid v1 card', () => {
    expect(
      parseForwardCard(
        JSON.stringify({
          bundleId: '01kyvxcfq0qweb86nsy3d3sdf3',
          summaryLines: ['王涛：[图片]', '王涛：你好'],
          messageCount: 6,
        }),
      ),
    ).toEqual({
      bundleId: '01kyvxcfq0qweb86nsy3d3sdf3',
      summaryLines: ['王涛：[图片]', '王涛：你好'],
      messageCount: 6,
    });
  });

  it('rejects malformed content', () => {
    const malformed = [
      'not json',
      '{}',
      '{"bundleId":"x","summaryLines":[1],"messageCount":1}',
      '{"bundleId":"x","summaryLines":[],"messageCount":-1}',
    ];
    for (const content of malformed) {
      expect(parseForwardCard(content)).toBeNull();
    }
  });
});
