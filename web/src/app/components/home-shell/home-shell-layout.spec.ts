import {
  crossesExpandedLayout,
  nextConversationListWidth,
  shouldCloseChatOnThreadSelect,
} from './home-shell.component';

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

describe('adaptive top-section reconciliation', () => {
  it('preserves state between compact and medium because they share the inline section model', () => {
    expect(crossesExpandedLayout('compact', 'medium')).toBe(false);
    expect(crossesExpandedLayout('medium', 'compact')).toBe(false);
  });

  it('reconciles the top section when either side of the transition is expanded', () => {
    expect(crossesExpandedLayout('medium', 'expanded')).toBe(true);
    expect(crossesExpandedLayout('expanded', 'compact')).toBe(true);
  });
});

describe('two-column thread selection', () => {
  it('closes the chatbox on PC when the open thread is selected again', () => {
    expect(shouldCloseChatOnThreadSelect('expanded', 42, 42)).toBe(true);
  });

  it('closes the chatbox on Pad when the open thread is selected again', () => {
    expect(shouldCloseChatOnThreadSelect('medium', 42, 42)).toBe(true);
  });

  it('opens a different thread normally', () => {
    expect(shouldCloseChatOnThreadSelect('expanded', 42, 7)).toBe(false);
  });

  it('keeps the existing behavior in the compact single-column layout', () => {
    expect(shouldCloseChatOnThreadSelect('compact', 42, 42)).toBe(false);
  });
});
