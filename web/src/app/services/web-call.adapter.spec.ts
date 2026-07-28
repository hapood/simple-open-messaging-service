import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { IDLE_CALL, type CallSnapshot } from './call-adapter';
import { WebCallAdapter } from './web-call.adapter';

describe('WebCallAdapter multi-device ownership', () => {
  it('dismisses this renderer when a sibling device accepts the incoming call', async () => {
    const http = {
      post: () => of({ code: 0, message: '' }),
    } as unknown as HttpClient;
    const adapter = new WebCallAdapter(http, IDLE_CALL);
    const snapshots: CallSnapshot[] = [];
    adapter.setSnapshotListener((snapshot) => snapshots.push(snapshot));
    const incoming: CallSnapshot = {
      ...IDLE_CALL,
      phase: 'incoming',
      callSid: 'call-1',
      peerUserId: 7,
    };
    await adapter.onIncoming(incoming);

    adapter.applyLifecycle({ ...incoming, phase: 'connecting' });

    expect(snapshots.at(-1)?.phase).toBe('ended');
    expect(adapter.snapshot().phase).toBe('idle');
  });
});
