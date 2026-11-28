import { AppDataLifetime } from './app-data-lifetime.service';
import { SessionSupersededError } from './session/session-identity';

describe('AppDataLifetime', () => {
  it('permits startup and failed-login invalidations before the first admission', () => {
    const lifetime = new AppDataLifetime();
    const terminal = lifetime.signal;
    lifetime.invalidateWork();
    lifetime.invalidateWork();
    expect(lifetime.signal.aborted).toBe(false);
    lifetime.assertCanAuthenticate();
    lifetime.admit();
    expect(lifetime.signal).toBe(terminal);
    expect(terminal.aborted).toBe(false);
    expect(() => lifetime.assertCanAuthenticate()).toThrow(
      SessionSupersededError,
    );
  });

  it('synchronously cancels admitted data work and can never reopen', () => {
    const lifetime = new AppDataLifetime();
    const cancelled = vi.fn();
    lifetime.signal.addEventListener('abort', cancelled);
    lifetime.admit();
    lifetime.invalidateWork();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(() => lifetime.assertActive()).toThrow(SessionSupersededError);
    expect(() => lifetime.admit()).toThrow(SessionSupersededError);
    lifetime.end();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('stays closed while a requested document replacement is delayed', () => {
    const lifetime = new AppDataLifetime();
    const replace = vi.fn();
    lifetime.restart(replace);
    lifetime.restart(replace);
    expect(replace).toHaveBeenCalledOnce();
    expect(() => lifetime.assertCanAuthenticate()).toThrow(
      SessionSupersededError,
    );
    const nextDocument = new AppDataLifetime();
    expect(() => nextDocument.admit()).not.toThrow();
  });

  it('stays closed if document replacement fails and permits retrying replacement', () => {
    const lifetime = new AppDataLifetime();
    const replace = vi.fn().mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    expect(() => lifetime.restart(replace)).toThrow('blocked');
    expect(() => lifetime.admit()).toThrow(SessionSupersededError);
    lifetime.restart(replace);
    expect(replace).toHaveBeenCalledTimes(2);
  });
});
