import { applyMessageListItemSemantics } from './create-item';

describe('message row accessibility semantics', () => {
  it('marks a dynamically mounted message as a list item without making it a live region', () => {
    const element = document.createElement('article');

    applyMessageListItemSemantics(element);

    expect(element.getAttribute('role')).toBe('listitem');
    expect(element.hasAttribute('aria-live')).toBeFalse();
  });
});
