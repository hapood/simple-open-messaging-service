import { MountedMessageScroll } from './mounted-message-scroll';

describe('MountedMessageScroll', () => {
  function setup() {
    const viewport = document.createElement('div');
    // A detached element has no scroll range; model an in-progress position.
    Object.defineProperty(viewport, 'scrollTop', { value: 0, writable: true });
    const scroll = vi.spyOn(viewport, 'scrollTo').mockImplementation(() => {});
    return { viewport, scroll, motion: new MountedMessageScroll(viewport) };
  }

  it.each(['wheel', 'touchstart', 'pointerdown'])(
    'stops on %s without preventing user input',
    (type) => {
      const { viewport, scroll, motion } = setup();
      motion.start(500, true);
      viewport.scrollTop = 123;
      const event = new Event(type, { cancelable: true });
      viewport.dispatchEvent(event);
      expect(scroll).toHaveBeenLastCalledWith({
        top: 123,
        behavior: 'instant',
      });
      expect(event.defaultPrevented).toBe(false);
      scroll.mockClear();
      viewport.dispatchEvent(new Event(type));
      expect(scroll).not.toHaveBeenCalled();
    },
  );

  it('replaces a running scroll and releases it on unbind', () => {
    const { viewport, scroll, motion } = setup();
    motion.start(500, true);
    viewport.scrollTop = 90;
    motion.start(700, true);
    expect(scroll.mock.calls.map(([options]) => options)).toEqual([
      { top: 500, behavior: 'smooth' },
      { top: 90, behavior: 'instant' },
      { top: 700, behavior: 'smooth' },
    ]);
    motion.cancel();
    scroll.mockClear();
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    expect(scroll).not.toHaveBeenCalled();
  });

  it('releases listeners on completion and uses instant positioning for reduced motion', () => {
    const { viewport, scroll, motion } = setup();
    motion.start(500, true);
    viewport.dispatchEvent(new Event('scrollend'));
    scroll.mockClear();
    motion.cancel();
    expect(scroll).not.toHaveBeenCalled();
    motion.start(200, false);
    expect(scroll).toHaveBeenLastCalledWith({ top: 200, behavior: 'instant' });
    scroll.mockClear();
    viewport.dispatchEvent(new Event('wheel'));
    expect(scroll).not.toHaveBeenCalled();
  });
});
