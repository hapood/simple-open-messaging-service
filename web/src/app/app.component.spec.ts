import { AppComponent } from './app.component';

describe('AppComponent context menu', () => {
  function contextMenu(target: Element): MouseEvent {
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    return event;
  }

  it('prevents the browser native context menu outside editable controls', () => {
    const target = document.createElement('div');
    const event = contextMenu(target);

    AppComponent.prototype.preventNativeContextMenu(event);

    expect(event.defaultPrevented).toBeTrue();
  });

  for (const selector of ['input', 'textarea', 'contenteditable'] as const) {
    it(`keeps the native context menu for ${selector}`, () => {
      const target = document.createElement(
        selector === 'contenteditable' ? 'div' : selector,
      );
      if (selector === 'contenteditable')
        target.setAttribute('contenteditable', 'true');
      const event = contextMenu(target);

      AppComponent.prototype.preventNativeContextMenu(event);

      expect(event.defaultPrevented).toBeFalse();
    });
  }
});
