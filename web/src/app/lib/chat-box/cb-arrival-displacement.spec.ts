import { planArrivalDisplacement } from './cb-arrival-displacement';

describe('planArrivalDisplacement', () => {
  it('uses scrollTop branch when both before and after exceed viewport height', () => {
    expect(
      planArrivalDisplacement({
        beforeTotalH: 900,
        afterTotalH: 960,
        viewportHeight: 600,
        beforeScrollTop: 300,
        animate: true,
      }),
    ).toEqual({
      mode: 'scrollTop',
      startScrollTop: 300,
      finalScrollTop: 360,
    });
  });

  it('uses transform branch when both before and after fit within viewport height', () => {
    expect(
      planArrivalDisplacement({
        beforeTotalH: 200,
        afterTotalH: 240,
        viewportHeight: 600,
        beforeScrollTop: 0,
        animate: true,
      }),
    ).toEqual({
      mode: 'transform',
      finalScrollTop: 0,
      startTranslateY: 40,
    });
  });

  it('uses transform branch with finalScrollTop=afterOverflow when crossing from <= vh to > vh', () => {
    expect(
      planArrivalDisplacement({
        beforeTotalH: 580,
        afterTotalH: 640,
        viewportHeight: 600,
        beforeScrollTop: 0,
        animate: true,
      }),
    ).toEqual({
      mode: 'transform',
      finalScrollTop: 40,
      startTranslateY: 60,
    });
  });

  it('snaps immediately with mode=none when shrinking (including > vh to <= vh)', () => {
    expect(
      planArrivalDisplacement({
        beforeTotalH: 620,
        afterTotalH: 580,
        viewportHeight: 600,
        beforeScrollTop: 20,
        animate: true,
      }),
    ).toEqual({
      mode: 'none',
      finalScrollTop: 0,
    });
  });
});
