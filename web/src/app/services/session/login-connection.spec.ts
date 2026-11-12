import { LoginConnection } from './login-connection';
import {
  createSessionCacheDescriptor,
  SessionSupersededError,
} from './session-identity';

describe('LoginConnection', () => {
  it('admits only its own captured work', () => {
    const id = createSessionCacheDescriptor().id;
    const first = new LoginConnection(id);
    const other = new LoginConnection(id);
    const work = first.capture();
    expect(first.isCurrent(work)).toBe(true);
    expect(other.isCurrent(work)).toBe(false);
    expect(() => other.assertCurrent(work)).toThrow(SessionSupersededError);
  });

  it('ends synchronously and cannot reactivate even when the UUID is reused', () => {
    const id = createSessionCacheDescriptor().id;
    const first = new LoginConnection(id);
    const work = first.capture();
    const aborted = vi.fn();
    work.signal.addEventListener('abort', aborted);
    first.end();
    first.end();
    expect(aborted).toHaveBeenCalledOnce();
    expect(first.isCurrent(work)).toBe(false);
    expect(() => first.assertCurrent(work)).toThrow(SessionSupersededError);
    expect(new LoginConnection(id).isCurrent(work)).toBe(false);
  });
});
