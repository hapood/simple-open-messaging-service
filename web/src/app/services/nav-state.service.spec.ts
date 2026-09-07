import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavStateMachineService } from './nav-state.service';
import { UserService } from './user.service';
import { SessionLifecycleService } from './session-lifecycle.service';

/** The nav state machine is the trickiest, most regression-prone logic in the shell — its `back()` layering
 *  and the section/reset methods have no compile-time guard, so these tests lock the invariants in. */
describe('NavStateMachineService', () => {
  let svc: NavStateMachineService;
  // The session-end effect watches UserService.sessionUserId; stubbed to a controllable signal so the
  // session-end reset tests can drive the id → null edge without instantiating the real UserService (and its
  // WebdbService / ProfileRepository dependency chain). Starts null — the boot state — so existing tests
  // (which never end a session) are unaffected by the effect.
  let sessionUserId: ReturnType<typeof signal<number | null>>;

  beforeEach(() => {
    sessionUserId = signal<number | null>(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        NavStateMachineService,
        { provide: UserService, useValue: { sessionUserId } },
      ],
    });
    svc = TestBed.inject(NavStateMachineService);
  });

  // ── back() layering: pane → aside → search → settingsCategoryStack → topSection → chat → exit ──

  it('back() peels the topmost pane before anything beneath it', () => {
    svc.openChat(1); // chat first, then a dialog stacked over it
    svc.pushPane({ kind: 'dialog' });
    expect(svc.back()).toBe(true);
    expect(svc.paneStack().length).toBe(0);
    expect(svc.chatThreadId()).toBe(1); // the chat was not reached yet
  });

  it('back() peels a mobile Settings category before its owning page dialog', () => {
    svc.pushPane({ kind: 'dialog', settingsDrilldown: true });
    svc.openSettingsCategory('devices');
    expect(svc.back()).toBe(true);
    expect(svc.settingsCategoryTop()).toBeUndefined();
    expect(svc.paneStack().length).toBe(1);
    expect(svc.back()).toBe(true);
    expect(svc.paneStack().length).toBe(0);
  });

  it('back() closes a nested dialog above mobile Settings before its category', () => {
    svc.pushPane({ kind: 'dialog', settingsDrilldown: true });
    svc.openSettingsCategory('devices');
    svc.pushPane({ kind: 'dialog' });
    expect(svc.back()).toBe(true);
    expect(svc.settingsCategoryTop()).toBe('devices');
    expect(svc.paneStack().length).toBe(1);
  });

  it('back() closes a root chat-scoped aside overlay', () => {
    svc.openAside('profile');
    expect(svc.back()).toBe(true);
    expect(svc.aside().length).toBe(0);
  });

  it('back() returns from an aside drill-down to its parent', () => {
    svc.openAside('group-info');
    svc.pushAside('group-join-requests');

    expect(svc.asideTop()?.panel).toBe('group-join-requests');
    expect(svc.back()).toBe(true);
    expect(svc.asideTop()?.panel).toBe('group-info');
    expect(svc.back()).toBe(true);
    expect(svc.aside()).toEqual([]);
  });

  it('uses the same aside drill-down stack for group member management', () => {
    svc.openAside('group-info');
    svc.pushAside('group-members');

    expect(svc.asideTop()?.panel).toBe('group-members');
    expect(svc.back()).toBe(true);
    expect(svc.asideTop()?.panel).toBe('group-info');
  });

  it('back() closes in-chat search before the chat itself', () => {
    svc.openChat(7);
    svc.openSearch();
    expect(svc.back()).toBe(true);
    expect(svc.searchOpen()).toBe(false);
    expect(svc.chatThreadId()).toBe(7); // chat still open
  });

  it('back() leaves a covering section before closing the preserved chat beneath it', () => {
    svc.openChat(3);
    svc.setTopSection('settings');
    expect(svc.back()).toBe(true);
    expect(svc.chatThreadId()).toBe(3);
    expect(svc.topSection()).toBe('chats');
    expect(svc.back()).toBe(true);
    expect(svc.chatThreadId()).toBeUndefined();
  });

  it('back() peels the Settings drill stack one level at a time (multi-level)', () => {
    svc.setTopSection('settings');
    svc.openSettingsCategory('a');
    svc.openSettingsCategory('b');
    expect(svc.settingsCategoryTop()).toBe('b'); // deepest on top
    expect(svc.back()).toBe(true);
    expect(svc.settingsCategoryTop()).toBe('a'); // peeled b → a
    expect(svc.topSection()).toBe('settings'); // still in the section
    expect(svc.back()).toBe(true);
    expect(svc.settingsCategoryTop()).toBeUndefined(); // peeled a → root
    expect(svc.topSection()).toBe('settings');
    expect(svc.back()).toBe(true);
    expect(svc.topSection()).toBe('chats'); // root → leave the section
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

  // ── resetAdaptiveTopSection (expanded-layout boundary) ──

  it('resetAdaptiveTopSection leaves the mobile section but preserves responsive chat layers', () => {
    svc.openChat(9);
    svc.setTopSection('settings');
    svc.openSettingsCategory('devices');
    svc.pushPane({ kind: 'dialog' });
    svc.openSearch();
    svc.openAside('profile');
    svc.resetAdaptiveTopSection();
    expect(svc.paneStack().length).toBe(1);
    expect(svc.aside().length).toBe(1);
    expect(svc.searchOpen()).toBe(true);
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

  it('consumes a group-joined transition once and does not replay it', () => {
    svc.openChat(22, 'group-joined');
    expect(svc.consumeChatTransition(22)).toBe('group-joined');
    expect(svc.consumeChatTransition(22)).toBe('standard');
  });

  it('does not leak a group-joined transition into a later ordinary open', () => {
    svc.openChat(22, 'group-joined');
    svc.openChat(23);
    expect(svc.consumeChatTransition(22)).toBe('standard');
    expect(svc.consumeChatTransition(23)).toBe('standard');
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

  // ── session-end reset (logout / 401-bounce / account switch: sessionUserId → null) ──

  it('drops every nav layer when the session ends (sessionUserId → null)', () => {
    const tick = () => TestBed.inject(ApplicationRef).tick();
    // A logged-in user navigated somewhere before logging out: opened a chat, a chat-scoped aside, in-chat
    // search, drilled into Settings, opened a dialog, switched to the Profile mobile section.
    sessionUserId.set(5);
    tick();
    svc.openChat(123);
    svc.openAside('profile');
    svc.openSearch();
    svc.openSettingsCategory('devices');
    svc.pushPane({ kind: 'dialog' });
    svc.setTopSection('profile');

    // Logout → UserService.clearSession sets sessionUserId back to null → the effect fires the hard reset.
    sessionUserId.set(null);
    tick();

    expect(svc.topSection()).toBe('chats');
    expect(svc.chatThreadId()).toBeUndefined();
    expect(svc.aside()).toEqual([]);
    expect(svc.searchOpen()).toBe(false);
    expect(svc.settingsCategoryStack()).toEqual([]);
    expect(svc.paneStack()).toEqual([]);
  });

  it('closes cached navigation on logout before HELLO identifies the session', () => {
    TestBed.inject(ApplicationRef).tick();
    expect(sessionUserId()).toBeNull();
    svc.openChat(39);
    svc.openAside('profile');
    svc.openSearch();
    svc.openSettingsCategory('devices');
    svc.pushPane({ kind: 'dialog' });
    svc.setTopSection('profile');

    TestBed.inject(SessionLifecycleService).endSession();

    expect(svc.chatThreadId()).toBeUndefined();
    expect(svc.aside()).toEqual([]);
    expect(svc.searchOpen()).toBe(false);
    expect(svc.settingsCategoryStack()).toEqual([]);
    expect(svc.paneStack()).toEqual([]);
    expect(svc.topSection()).toBe('chats');
  });

  it('does not reset on login or when the same id is re-emitted (reconnect HELLO)', () => {
    const tick = () => TestBed.inject(ApplicationRef).tick();
    sessionUserId.set(7);
    tick();
    svc.openChat(999);
    svc.setTopSection('settings');

    sessionUserId.set(7); // reconnect re-emits the same userId — must NOT tear down the open chat
    tick();

    expect(svc.chatThreadId()).toBe(999);
    expect(svc.topSection()).toBe('settings');
  });
});
