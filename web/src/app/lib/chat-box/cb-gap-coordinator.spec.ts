import { CbGapCoordinator } from './cb-gap-coordinator';

interface Msg {
  seq: number;
}

describe('CbGapCoordinator', () => {
  it('admits bottom-most when pinToBottom is true, and closest-to-viewport otherwise', () => {
    const coord = new CbGapCoordinator<Msg>();
    coord.register({
      id: 'top',
      left: 0,
      right: 20,
      kind: 'localGap',
      direction: 'older',
    });
    coord.register({
      id: 'middle',
      left: 40,
      right: 60,
      kind: 'localGap',
      direction: 'older',
    });
    coord.register({
      id: 'bottom',
      left: 80,
      right: 100,
      kind: 'serverPending',
      direction: 'newer',
    });
    coord.stageReadyPage('top', { left: 10, right: 20, messages: [{ seq: 15 }] });
    coord.stageReadyPage('middle', { left: 40, right: 50, messages: [{ seq: 45 }] });
    coord.stageReadyPage('bottom', { left: 80, right: 90, messages: [{ seq: 85 }] });

    // Not pinned to bottom: pick closest to viewport ('middle' at distance 0).
    const distMap: Record<string, number> = { top: 400, middle: 0, bottom: 300 };
    const first = coord.admitOne((m) => m.seq, {
      pinToBottom: false,
      distanceToViewport: (g) => distMap[g.id],
    });
    expect(first.admitted?.id).toBe('middle');
    expect(first.filteredMessages).toEqual([{ seq: 45 }]);
    expect(first.hasMoreReady).toBe(true);

    // Pinned to bottom: pick bottom-most ('bottom') regardless of distance.
    const second = coord.admitOne((m) => m.seq, {
      pinToBottom: true,
      distanceToViewport: (g) => distMap[g.id],
    });
    expect(second.admitted?.id).toBe('bottom');
    expect(second.filteredMessages).toEqual([{ seq: 85 }]);
    expect(second.hasMoreReady).toBe(true);

    const third = coord.admitOne((m) => m.seq, { pinToBottom: true });
    expect(third.admitted?.id).toBe('top');
    expect(third.hasMoreReady).toBe(false);
  });

  it('filters tombs for the active stale consumer without inheriting them to residual gaps', () => {
    const coord = new CbGapCoordinator<Msg>();
    coord.register({
      id: 'g1',
      left: 10,
      right: 50,
      kind: 'localGap',
      direction: 'older',
    });
    coord.recordTomb(35);
    coord.stageReadyPage('g1', {
      left: 30,
      right: 50,
      messages: [{ seq: 35 }, { seq: 40 }],
    });

    const admitted = coord.admitOne((m) => m.seq, { pinToBottom: true });
    expect(admitted.filteredMessages).toEqual([{ seq: 40 }]);

    // Residual gap (10, 30] must NOT inherit consumerTombs from g1.
    const [residual] = coord.replace('g1', [
      {
        id: 'g2',
        left: 10,
        right: 30,
        kind: 'localGap',
        direction: 'older',
      },
    ]);
    expect(residual.consumerTombs.size).toBe(0);
  });

  it('ignores ready pages staged for removed gaps', () => {
    const coord = new CbGapCoordinator<Msg>();
    coord.register({
      id: 'g1',
      left: 0,
      right: 10,
      kind: 'localGap',
      direction: 'older',
    });
    coord.remove('g1');
    expect(
      coord.stageReadyPage('g1', { left: 0, right: 10, messages: [{ seq: 5 }] }),
    ).toBe(false);
    expect(coord.admitOne((m) => m.seq, { pinToBottom: true }).admitted).toBeNull();
  });
});
