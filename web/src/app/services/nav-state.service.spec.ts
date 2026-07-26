import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { NavStateMachineService } from './nav-state.service';

/** The nav state machine is the trickiest, most regression-prone logic in the shell — its `back()` layering
 *  and the section/reset methods have no compile-time guard, so these tests lock the invariants in. */
describe('NavStateMachineService', () => {
  let svc: NavStateMachineService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), NavStateMachineService],
    });
    svc = TestBed.inject(NavStateMachineService);
  });

  // ── back() layering: pane → aside → search → chat → settingsCategoryStack → topSection → exit ──

  it('back() peels the topmost pane before anything beneath it', () => {
    svc.openChat(1);                    // chat first, then a dialog stacked over it
    svc.pushPane({ kind: 'dialog' });
    expect(svc.back()).toBe(true);
    expect(svc.paneStack().length).toBe(0);
    expect(svc.chatThreadId()).toBe(1); // the chat was not reached yet
  });

  it('back() closes the chat-scoped aside overlay (single-depth)', () => {
    svc.openAside('profile');
    expect(svc.back()).toBe(true);
    expect(svc.aside().length).toBe(0);
  });

  it('back() closes in-chat search before the chat itself', () => {
    svc.openChat(7);
    svc.openSearch();
    expect(svc.back()).toBe(true);
    expect(svc.searchOpen()).toBe(false);
    expect(svc.chatThreadId()).toBe(7); // chat still open
  });

  it('back() closes the chat before leaving a non-chats section', () => {
    svc.openChat(3);
    svc.setTopSection('settings');
    expect(svc.back()).toBe(true);
    expect(svc.chatThreadId()).toBeUndefined();
    expect(svc.topSection()).toBe('settings'); // section survives the chat-close back…
    expect(svc.back()).toBe(true);
    expect(svc.topSection()).toBe('chats');    // …then peels back to chats
  });

  it('back() peels the Settings drill stack one level at a time (multi-level)', () => {
    svc.setTopSection('settings');
    svc.openSettingsCategory('a');
    svc.openSettingsCategory('b');
    expect(svc.settingsCategoryTop()).toBe('b');        // deepest on top
    expect(svc.back()).toBe(true);
    expect(svc.settingsCategoryTop()).toBe('a');        // peeled b → a
    expect(svc.topSection()).toBe('settings');          // still in the section
    expect(svc.back()).toBe(true);
    expect(svc.settingsCategoryTop()).toBeUndefined();  // peeled a → root
    expect(svc.topSection()).toBe('settings');
    expect(svc.back()).toBe(true);
    expect(svc.topSection()).toBe('chats');             // root → leave the section
  });

  it('back() returns false only at home (chats, nothing open)', () => {
    expect(svc.back()).toBe(false);
  });

  // ── setTopSection ──

  it('setTopSection clears the settings drill stack but keeps the open chat', () => {
    svc.openChat(5);
    svc.setTopSection('settings');
    svc.openSettingsCategory('devices');
    svc.setTopSection('profile');
    expect(svc.topSection()).toBe('profile');
    expect(svc.settingsCategoryTop()).toBeUndefined();
    expect(svc.chatThreadId()).toBe(5);
  });

  // ── resetTransientExceptChat (breakpoint-change reset) ──

  it('resetTransientExceptChat drops panes/aside/search/settingsCategoryStack/topSection but keeps the chat', () => {
    svc.openChat(9);
    svc.setTopSection('settings');
    svc.openSettingsCategory('devices');
    svc.pushPane({ kind: 'dialog' });
    svc.openSearch();
    svc.openAside('profile');
    svc.resetTransientExceptChat();
    expect(svc.paneStack().length).toBe(0);
    expect(svc.aside().length).toBe(0);
    expect(svc.searchOpen()).toBe(false);
    expect(svc.settingsCategoryTop()).toBeUndefined();
    expect(svc.topSection()).toBe('chats');
    expect(svc.chatThreadId()).toBe(9); // the anchor survives
  });

  // ── openChat / closeChat scope-clearing ──

  it('openChat clears panes + search + aside on a thread switch', () => {
    svc.pushPane({ kind: 'dialog' });
    svc.openSearch();
    svc.openAside('profile');
    svc.openChat(2);
    expect(svc.paneStack().length).toBe(0);
    expect(svc.searchOpen()).toBe(false);
    expect(svc.aside().length).toBe(0);
    expect(svc.chatThreadId()).toBe(2);
  });

  it('closeChat clears panes/aside/search + chatThreadId', () => {
    svc.openChat(4);
    svc.pushPane({ kind: 'dialog' });
    svc.openSearch();
    svc.openAside('profile');
    svc.closeChat();
    expect(svc.chatThreadId()).toBeUndefined();
    expect(svc.paneStack().length).toBe(0);
    expect(svc.aside().length).toBe(0);
    expect(svc.searchOpen()).toBe(false);
  });
});
