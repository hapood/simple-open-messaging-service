import { PlaygroundLinkGeneration } from './playground-link-generation.mock';

describe('PlaygroundLinkGeneration', () => {
  it('models a failed fetch with a sendable default card', async () => {
    vi.useFakeTimers();
    const service = new PlaygroundLinkGeneration();

    const generation = await service.begin(
      'https://www.zhihu.com/question/1',
      'See https://www.zhihu.com/question/1',
      '00000000-0000-4000-8000-000000000001',
    );
    expect(
      service.snapshot('00000000-0000-4000-8000-000000000001')?.status,
    ).toBe('pending');
    expect(generation.status).toBe('pending');
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    const completed = service.snapshot(generation.generationId);
    vi.useRealTimers();

    expect(completed?.status).toBe('failed');
    expect(completed?.content).toEqual({
      url: 'https://www.zhihu.com/question/1',
      title: 'zhihu.com',
      description: 'See',
    });
  });
});
