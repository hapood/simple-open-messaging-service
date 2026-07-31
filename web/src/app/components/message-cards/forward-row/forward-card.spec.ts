import { parseForwardCard } from './forward-card';

describe('parseForwardCard', () => {
  it('parses a valid v1 card', () => {
    expect(
      parseForwardCard(
        JSON.stringify({
          version: 1,
          bundleId: '01kyvxcfq0qweb86nsy3d3sdf3',
          summaryLines: ['王涛：[图片]', '王涛：你好'],
          messageCount: 6,
          assetCount: 3,
        }),
      ),
    ).toEqual({
      version: 1,
      bundleId: '01kyvxcfq0qweb86nsy3d3sdf3',
      summaryLines: ['王涛：[图片]', '王涛：你好'],
      messageCount: 6,
      assetCount: 3,
    });
  });

  it('rejects malformed content', () => {
    const malformed = [
      'not json',
      '{}',
      '{"version":2,"bundleId":"x","summaryLines":[],"messageCount":1,"assetCount":0}',
      '{"version":1,"bundleId":"x","summaryLines":[1],"messageCount":1,"assetCount":0}',
    ];
    for (const content of malformed) {
      expect(parseForwardCard(content)).toBeNull();
    }
  });
});
