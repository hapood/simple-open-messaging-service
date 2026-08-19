import { ComposerGeometryService } from './composer-geometry.service';

describe('ComposerGeometryService', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--soms-composer-height');
  });

  it('publishes zero only for a non-friend thread without a composer', () => {
    const service = new ComposerGeometryService();
    const retainedThread = document.createElement('div');
    retainedThread.classList.add('msg-container--friendship-ended');

    const stop = service.observe(retainedThread);

    expect(
      document.documentElement.style.getPropertyValue('--soms-composer-height'),
    ).toBe('0px');
    stop();
  });

  it('keeps normal seeded geometry for other states without a web composer', () => {
    const service = new ComposerGeometryService();
    const temporarilyHidden = document.createElement('div');

    const stop = service.observe(temporarilyHidden);

    expect(
      document.documentElement.style.getPropertyValue('--soms-composer-height'),
    ).toBe('74px');
    stop();
  });
});
