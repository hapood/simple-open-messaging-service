import { nextConversationListWidth } from './home-shell.component';

describe('expanded conversation-list keyboard resizer', () => {
  it('moves one 16px step with the horizontal arrow keys', () => {
    expect(nextConversationListWidth(360, 'ArrowLeft')).toBe(344);
    expect(nextConversationListWidth(360, 'ArrowRight')).toBe(376);
  });

  it('jumps to the supported bounds with Home and End', () => {
    expect(nextConversationListWidth(360, 'Home')).toBe(280);
    expect(nextConversationListWidth(360, 'End')).toBe(480);
  });

  it('clamps repeated movement at the supported bounds', () => {
    expect(nextConversationListWidth(280, 'ArrowLeft')).toBe(280);
    expect(nextConversationListWidth(480, 'ArrowRight')).toBe(480);
  });

  it('leaves unrelated keyboard input to the browser', () => {
    expect(nextConversationListWidth(360, 'Tab')).toBeUndefined();
  });
});
