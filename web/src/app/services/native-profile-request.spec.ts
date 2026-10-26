import { nativeProfileRequest } from './native-profile-request';
import type { ProfileRequest } from '../../../../shared/profile-demand';

class TestChannel<T> {
  constructor(public onmessage: (message: T) => void = () => {}) {}
}
const invoke = vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>();
const request: ProfileRequest = {
  publisherNamespaceId: 7,
  lookup: 'GROUP_MEMBER_PROFILE',
  groupAccount: '!team',
  target: { profileNamespaceId: 12, account: 'alice', rev: 3 },
};

describe('native profile request cancellation', () => {
  let original: Window['__TAURI__'];
  beforeEach(() => {
    original = window.__TAURI__;
    window.__TAURI__ = { core: { Channel: TestChannel, invoke } };
    invoke.mockReset();
  });
  afterEach(() => {
    window.__TAURI__ = original;
  });

  it.each([false, true])(
    'forwards abort exactly once after registration (ack first: %s)',
    async (ackFirst) => {
      let finish!: (result: unknown) => void;
      invoke.mockImplementation((command) =>
        command === 'native_profile_resolve'
          ? new Promise((resolve) => {
              finish = resolve;
            })
          : Promise.resolve(true),
      );
      const controller = new AbortController();
      const pending = nativeProfileRequest(42, request, controller.signal);
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'AbortError',
      });
      const args = invoke.mock.calls[0][1]!;
      const ack = args['registered'] as TestChannel<null>;
      expect(args['request']).toEqual(request);
      if (ackFirst) ack.onmessage(null);
      controller.abort();
      if (!ackFirst) {
        expect(invoke).toHaveBeenCalledTimes(1);
        ack.onmessage(null);
      }
      ack.onmessage(null);
      expect(invoke).toHaveBeenCalledTimes(2);
      expect(invoke).toHaveBeenLastCalledWith('cancel_http_request', {
        reqId: args['requestId'],
      });
      finish({ status: 'CANCELLED' });
      await assertion;
    },
  );

  it('does not invoke Rust for an already aborted consumer', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      nativeProfileRequest(42, request, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not send a late cancellation for a completed invocation', async () => {
    invoke.mockResolvedValue({ status: 'READY', profile: {} });
    const controller = new AbortController();
    await nativeProfileRequest(42, request, controller.signal);
    const args = invoke.mock.calls[0][1]!;
    controller.abort();
    (args['registered'] as TestChannel<null>).onmessage(null);
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
