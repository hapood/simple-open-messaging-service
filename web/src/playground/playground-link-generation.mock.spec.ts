import { PlaygroundLinkGeneration } from './playground-link-generation.mock';

describe('PlaygroundLinkGeneration', () => {
  it('models a failed fetch with a sendable default card', async () => {
    const service = new PlaygroundLinkGeneration();

    const generation = await service.begin(
      'https://www.zhihu.com/question/1',
      'See https://www.zhihu.com/question/1',
      '00000000-0000-4000-8000-000000000001',
    );

    expect(generation.status).toBe('failed');
    expect(generation.content).toEqual({
      url: 'https://www.zhihu.com/question/1',
      title: 'zhihu.com',
      description: 'See',
    });
  });
});
