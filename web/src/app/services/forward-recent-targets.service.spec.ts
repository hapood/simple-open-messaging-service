import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { ForwardRecentTargetsService } from './forward-recent-targets.service';
import { AppStateStorage } from './preference-storage';
import { SessionLifecycleService } from './session-lifecycle.service';
import {
  parseLoginSessionId,
  SessionSupersededError,
  type LoginSessionId,
} from './session/session-identity';

const FIRST = parseLoginSessionId('11111111-1111-4111-8111-111111111111');
const SECOND = parseLoginSessionId('22222222-2222-4222-8222-222222222222');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

describe('ForwardRecentTargetsService', () => {
  let recent: ForwardRecentTargetsService;
  let lifecycle: SessionLifecycleService;
  const appState = new AppStateStorage();

  function createRuntime(sessionId: LoginSessionId): void {
    TestBed.configureTestingModule({});
    lifecycle = TestBed.inject(SessionLifecycleService);
    lifecycle.bindSession(sessionId);
    recent = TestBed.inject(ForwardRecentTargetsService);
  }

  function recreateForSuccessor(): void {
    lifecycle.invalidateSession();
    expect(() => lifecycle.bindSession(SECOND)).toThrow(SessionSupersededError);
    TestBed.resetTestingModule();
    createRuntime(SECOND);
  }

  beforeEach(async () => {
    createRuntime(FIRST);
    await appState.update((state) => {
      state.delete('forwardRecentThreads');
      state.set('lifecycleState', 'active');
      state.set('sessionUuid', FIRST);
    });
  });

  afterEach(async () => {
    delete window.__TAURI_INTERNALS__;
    delete window.__TAURI__;
    vi.restoreAllMocks();
    try {
      await appState.update((state) => {
        state.delete('forwardRecentThreads');
        state.delete('lifecycleState');
        state.delete('sessionUuid');
      });
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('filters invalid stored IDs without retaining an account-scoped copy', async () => {
    await appState.set('forwardRecentThreads', [4, '5', 4, -1, 8]);
    expect(await recent.read()).toEqual([4, 8]);
    await appState.remove('forwardRecentThreads');
    expect(await recent.read()).toEqual([]);
  });

  it('serializes confirmations and keeps the most recent twelve unique targets', async () => {
    await Promise.all([recent.remember([1, 2]), recent.remember([2, 3])]);
    expect(await recent.read()).toEqual([2, 3, 1]);
    await recent.remember([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]);
    expect(await recent.read()).toEqual([2, 3, 1]);
    await recent.remember(Array.from({ length: 14 }, (_, index) => index + 10));
    const expected = Array.from({ length: 12 }, (_, index) => index + 10);
    expect(await recent.read()).toEqual(expected);
    expect(await appState.get('forwardRecentThreads')).toEqual(expected);
  });

  it('does not write a queued confirmation after its login is invalidated', async () => {
    const pending = recent.remember([7]);
    lifecycle.invalidateSession();
    expect(await pending).toEqual([]);
    expect(await appState.get('forwardRecentThreads')).toBeUndefined();
  });

  it('never treats a null renderer session as permission to write or read', async () => {
    lifecycle.invalidateSession();
    await appState.set('forwardRecentThreads', [8]);
    expect(await recent.remember([7])).toEqual([]);
    expect(await recent.read()).toEqual([]);
    expect(await appState.get('forwardRecentThreads')).toEqual([8]);
  });

  it('checks durable lifecycle and exact UUID even if the renderer mirror is stale', async () => {
    for (const [state, uuid] of [
      ['cleaning', FIRST],
      ['signed-out', undefined],
      ['active', SECOND],
    ]) {
      await appState.update((snapshot) => {
        snapshot.set('lifecycleState', state);
        snapshot.set('sessionUuid', uuid);
        snapshot.set('forwardRecentThreads', [9]);
      });
      expect(await recent.remember([7])).toEqual([]);
      expect(await recent.read()).toEqual([]);
      expect(await appState.get('forwardRecentThreads')).toEqual([9]);
    }
  });

  it('deletes an admitted write and rejects work delayed until after cleanup', async () => {
    await recent.remember([1]);
    const update = AppStateStorage.prototype.update;
    const admitted = deferred<void>();
    const resume = deferred<void>();
    vi.spyOn(AppStateStorage.prototype, 'update').mockImplementationOnce(
      async function <T>(
        this: AppStateStorage,
        change: (state: Map<string, unknown>) => T,
      ) {
        admitted.resolve();
        await resume.promise;
        return update.call(this, change) as Promise<T>;
      },
    );
    const delayed = recent.remember([2]);
    await admitted.promise;
    await appState.update((state) => {
      state.set('lifecycleState', 'signed-out');
      state.delete('sessionUuid');
      state.delete('forwardRecentThreads');
    });
    resume.resolve();
    expect(await delayed).toEqual([]);
    expect(await appState.get('forwardRecentThreads')).toBeUndefined();
  });

  it('discards a browser snapshot delivered after session replacement', async () => {
    const snapshot = deferred<ReadonlyMap<string, unknown>>();
    const admitted = deferred<void>();
    vi.spyOn(AppStateStorage.prototype, 'readSnapshot').mockImplementationOnce(
      () => {
        admitted.resolve();
        return snapshot.promise;
      },
    );
    const reading = recent.read();
    await admitted.promise;
    recreateForSuccessor();
    await appState.set('sessionUuid', SECOND);
    snapshot.resolve(
      new Map<string, unknown>([
        ['lifecycleState', 'active'],
        ['sessionUuid', FIRST],
        ['forwardRecentThreads', [7]],
      ]),
    );
    expect(await reading).toEqual([]);
    expect(await recent.remember([9])).toEqual([9]);
    expect(await recent.read()).toEqual([9]);
  });

  it('does not redirect an old dialog scope into a new login', async () => {
    const dialogScope = lifecycle.capture();
    const oldRecent = recent;
    recreateForSuccessor();
    await appState.set('sessionUuid', SECOND);
    expect(await oldRecent.remember([7], dialogScope)).toEqual([]);
    expect(await oldRecent.read(dialogScope)).toEqual([]);
    expect(await recent.remember([7], dialogScope)).toEqual([]);
    expect(await recent.read(dialogScope)).toEqual([]);
    expect(await appState.get('forwardRecentThreads')).toBeUndefined();
    expect(await recent.remember([9])).toEqual([9]);
    expect(await recent.read()).toEqual([9]);
  });

  it('delegates native policy to session-bound IPC and suppresses stale responses', async () => {
    const reply = deferred<number[]>();
    const admitted = deferred<void>();
    const invoke = vi.fn().mockImplementation(() => {
      admitted.resolve();
      return reply.promise;
    });
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    const remembering = recent.remember([2, 2, -1]);
    await admitted.promise;
    expect(invoke).toHaveBeenCalledWith('forward_recent_targets_remember', {
      expectedSessionUuid: FIRST,
      threadIds: [2, 2, -1],
    });
    recreateForSuccessor();
    reply.resolve([2]);
    expect(await remembering).toEqual([]);
    invoke.mockResolvedValueOnce([9]);
    expect(await recent.read()).toEqual([9]);
    expect(invoke).toHaveBeenLastCalledWith('forward_recent_targets_read', {
      expectedSessionUuid: SECOND,
    });
  });

  it('suppresses stale native reads and skips signed-out IPC', async () => {
    const reply = deferred<number[]>();
    const admitted = deferred<void>();
    const invoke = vi.fn().mockImplementation(() => {
      admitted.resolve();
      return reply.promise;
    });
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    const reading = recent.read();
    await admitted.promise;
    lifecycle.invalidateSession();
    reply.resolve([3]);
    expect(await reading).toEqual([]);
    expect(await recent.remember([4])).toEqual([]);
    expect(await recent.read()).toEqual([]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps optional native history failures from breaking later confirmations', async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce([2])
      .mockRejectedValueOnce(new Error('read unavailable'));
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = { core: { invoke } };
    expect(await recent.remember([1])).toEqual([]);
    expect(await recent.remember([2])).toEqual([2]);
    expect(await recent.read()).toEqual([]);
  });
});
