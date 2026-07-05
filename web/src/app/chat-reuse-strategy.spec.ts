import { ChatReuseStrategy } from './chat-reuse-strategy';
import type { ActivatedRouteSnapshot, Route } from '@angular/router';

/** Minimal ActivatedRouteSnapshot stub — the strategy only reads `routeConfig.path`. */
function snap(route: Route | undefined): ActivatedRouteSnapshot {
  return { routeConfig: route } as unknown as ActivatedRouteSnapshot;
}

const LIST = { path: '' } as Route;
const CHAT = { path: 'chat/:threadId' } as Route;
const LOGIN = { path: 'auth/login' } as Route;
const PROFILE = { path: 'profile', outlet: 'aside' } as Route;

describe('ChatReuseStrategy', () => {
  let strategy: ChatReuseStrategy;

  beforeEach(() => {
    strategy = new ChatReuseStrategy();
  });

  it('reuses ChatPane across the list ("") and chat ("chat/:threadId") children — the kernel never remounts on open/close', () => {
    expect(strategy.shouldReuseRoute(snap(LIST), snap(CHAT))).toBeTrue();
    expect(strategy.shouldReuseRoute(snap(CHAT), snap(LIST))).toBeTrue();
    // Two sibling routes have distinct config objects with the same paths — still reused.
    expect(strategy.shouldReuseRoute(snap({ path: '' } as Route), snap({ path: 'chat/:threadId' } as Route))).toBeTrue();
  });

  it('still reuses when the future and current configs are the same object (the default branch)', () => {
    const cfg = { path: 'chat/:threadId' } as Route;
    expect(strategy.shouldReuseRoute(snap(cfg), snap(cfg))).toBeTrue();
  });

  it('does NOT reuse across unrelated routes', () => {
    expect(strategy.shouldReuseRoute(snap(LIST), snap(LOGIN))).toBeFalse();
    expect(strategy.shouldReuseRoute(snap(CHAT), snap(PROFILE))).toBeFalse();
    expect(strategy.shouldReuseRoute(snap(LOGIN), snap(PROFILE))).toBeFalse();
  });

  it('inherits the safe defaults — never detaches/stores, so the chat view stays in the live outlet (no detached-DOM measurement corruption)', () => {
    expect(strategy.shouldDetach(snap(CHAT))).toBeFalse();
    expect(strategy.shouldAttach(snap(CHAT))).toBeFalse();
    expect(strategy.retrieve(snap(CHAT))).toBeNull();
    expect(() => strategy.store(snap(CHAT), {} as unknown as never)).not.toThrow();
  });
});
