import { ComposerGeometryService } from './composer-geometry.service';

describe('ComposerGeometryService', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--soms-composer-height');
  });

  it('stores zero on a non-friend thread without changing the global notification', () => {
    const service = new ComposerGeometryService();
    const retainedThread = document.createElement('div');
    retainedThread.classList.add('msg-container--friendship-ended');

    const stop = service.observe(retainedThread);

    expect(
      retainedThread.style.getPropertyValue('--soms-composer-height'),
    ).toBe('0px');
    expect(
      document.documentElement.style.getPropertyValue('--soms-composer-height'),
    ).toBe('74px');
    stop();
  });

  it('keeps normal seeded geometry for other states without a web composer', () => {
    const service = new ComposerGeometryService();
    const temporarilyHidden = document.createElement('div');

    const stop = service.observe(temporarilyHidden);

    expect(
      temporarilyHidden.style.getPropertyValue('--soms-composer-height'),
    ).toBe('74px');
    stop();
  });

  it('keeps each double-buffered pane independent when a retained thread has no composer', () => {
    const service = new ComposerGeometryService();
    const foreground = document.createElement('div');
    const composer = document.createElement('app-chat-input');
    const bar = document.createElement('div');
    bar.classList.add('ci-input-bar');
    bar.style.paddingBottom = '8px';
    Object.defineProperty(composer, 'offsetHeight', {
      configurable: true,
      value: 64,
    });
    composer.append(bar);
    foreground.append(composer);

    const background = document.createElement('div');
    background.classList.add('msg-container--friendship-ended');

    const stopForeground = service.observe(foreground);
    const stopBackground = service.observe(background);

    expect(foreground.style.getPropertyValue('--soms-composer-height')).toBe(
      '64px',
    );
    expect(background.style.getPropertyValue('--soms-composer-height')).toBe(
      '0px',
    );
    expect(
      document.documentElement.style.getPropertyValue('--soms-composer-height'),
    ).toBe('74px');

    service.setActive(foreground, true);

    expect(
      document.documentElement.style.getPropertyValue('--soms-composer-height'),
    ).toBe('64px');

    service.setActive(background, true);

    expect(
      document.documentElement.style.getPropertyValue('--soms-composer-height'),
    ).toBe('0px');

    stopBackground();
    stopForeground();
  });
});
