import { PlaygroundRealtime } from './playground-realtime.mock';

describe('PlaygroundRealtime', () => {
  it('presents an online facade while all transport controls remain inert', () => {
    const realtime = new PlaygroundRealtime();
    const events: unknown[] = [];
    const reconnects: unknown[] = [];
    realtime.eventSubject.subscribe((event) => events.push(event));
    realtime.reconnect$.subscribe((event) => reconnects.push(event));

    realtime.connect();
    realtime.retryNow();
    realtime.disconnect();

    expect(realtime.state()).toBe('open');
    expect(realtime.reconnectIn()).toBeNull();
    expect(events).toEqual([]);
    expect(reconnects).toEqual([]);
  });
});
