import { applyJumpHighlight } from './jump-highlight';

describe('applyJumpHighlight', () => {
  it('flashes an unselected exact media target without highlighting its host', () => {
    const host = document.createElement('div');
    const media = document.createElement('div');
    media.dataset['mediaMessageId'] = '42';
    host.appendChild(media);

    applyJumpHighlight(host, 42);

    expect(host.classList.contains('cb-jump-highlight')).toBe(false);
    expect(media.classList.contains('cb-jump-highlight-target')).toBe(true);
  });

  it('flashes an already-selected media target without changing its selection state', () => {
    const host = document.createElement('div');
    const media = document.createElement('div');
    media.dataset['mediaMessageId'] = '42';
    media.classList.add('msg-media-cell--selected');
    host.appendChild(media);

    applyJumpHighlight(host, 42);

    expect(host.classList.contains('cb-jump-highlight')).toBe(false);
    expect(media.classList.contains('cb-jump-highlight-target')).toBe(true);
    expect(media.classList.contains('msg-media-cell--selected')).toBe(true);
  });

  it('flashes an already-selected ordinary message without changing its selection state', () => {
    const host = document.createElement('div');
    host.classList.add('cb-message--selected');

    applyJumpHighlight(host, 42);

    expect(host.classList.contains('cb-jump-highlight')).toBe(true);
    expect(host.classList.contains('cb-message--selected')).toBe(true);
  });
});
