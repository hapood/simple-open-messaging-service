import {
  applyMessageListItemSemantics,
  createServerGapCbElement,
} from './create-item';

describe('message row accessibility semantics', () => {
  it('marks a dynamically mounted message as a list item without making it a live region', () => {
    const element = document.createElement('article');

    applyMessageListItemSemantics(element);

    expect(element.getAttribute('role')).toBe('listitem');
    expect(element.hasAttribute('aria-live')).toBe(false);
  });

  it('renders a server gap as one accessible non-message timeline note', () => {
    const rendered = createServerGapCbElement(
      {
        id: Number.MIN_SAFE_INTEGER + 1,
        data: {
          type: 'system',
          contentType: 'SYSTEM',
          msgId: 30,
          isSelf: false,
          name: '',
          text: '',
          time: '',
          images: null,
          file: null,
          createdAtMs: 0,
          serverGap: {
            left: 19,
            right: 30,
            state: 'SERVER_PENDING',
          },
        },
      },
      'Some history is temporarily unavailable',
    );

    expect(rendered.el.getAttribute('role')).toBe('listitem');
    expect(rendered.el.classList).toContain('cb-server-gap--pending');
    expect(rendered.el.textContent).toBe(
      'Some history is temporarily unavailable',
    );
    expect(rendered.el.querySelector('.msg-row')).toBeNull();
    rendered.destroy();
  });
});
