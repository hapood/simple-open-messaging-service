import {
  RealtimeTransport,
  type ConnectionState,
  type RealtimeSink,
  type StandardMessage,
} from './realtime-transport';
import { listenEvent, tauriInvoke } from './runtime';

/** Desktop renderer adapter for the shared Rust realtime runtime. Rust owns sockets, cached HELLO,
 * origin selection and retry policy. A renderer owns only listeners and its opaque control lease.
 * Android uses NativeEventTransport through its OS service; the browser uses WorkerSseTransport. */
export class RustChannelSseTransport extends RealtimeTransport {
  private installed = false;
  private epoch = 0;
  private instance: number | null = null;
  private unlisteners: Array<() => void> = [];
  private readonly onOnline = (): void => this.network(true);
  private readonly onOffline = (): void => this.network(false);

  start(): void {
    if (this.installed) return;
    this.installed = true;
    void this.startAsync(++this.epoch);
  }

  private current(epoch: number): boolean {
    return this.installed && this.epoch === epoch;
  }

  private dispose(listeners: Array<() => void>): void {
    for (const unlisten of listeners) {
      try {
        unlisten();
      } catch {
        // The platform may already have removed the listener.
      }
    }
  }

  private async startAsync(epoch: number): Promise<void> {
    const current = () => this.current(epoch);
    const listeners: Array<() => void> = [];
    try {
      // Keep local handles until admission. A delayed registration from an obsolete attach must not
      // enter a successor's listener array, or deliver events through its renewed installed flag.
      const subscriptions = await Promise.allSettled([
        listenEvent<ConnectionState>('soms-sse-state', (e) => {
          if (current()) this.sink.onState(e.payload);
        }),
        listenEvent<StandardMessage>('soms-sse-event', (e) => {
          if (current()) this.sink.onEvent(e.payload);
        }),
        listenEvent('soms-sse-reconnect', () => {
          if (current()) this.sink.onReconnect();
        }),
        listenEvent<{ reason?: string }>('soms-sse-force-logout', (e) => {
          if (current()) this.sink.onForceLogout(e.payload?.reason);
        }),
        listenEvent<number>('soms-sse-reconnect-in', (e) => {
          if (current()) this.sink.onReconnectIn(e.payload);
        }),
      ]);
      let failed = false;
      for (const result of subscriptions) {
        if (result.status === 'fulfilled') {
          if (result.value) listeners.push(result.value);
        } else failed = true;
      }
      if (failed || !current()) {
        this.dispose(listeners);
        if (current()) this.sink.onState('closed');
        return;
      }
      this.unlisteners = listeners;
      if (typeof window !== 'undefined') {
        window.addEventListener('online', this.onOnline);
        window.addEventListener('offline', this.onOffline);
      }
      const instance = await tauriInvoke<number>('sse_start');
      if (!Number.isSafeInteger(instance) || instance <= 0) {
        throw new Error('Invalid native realtime owner lease');
      }
      if (!current()) {
        // Rust transfers desktop ownership on reattach. This old lease cannot stop a newer renderer.
        void tauriInvoke('sse_stop', { instance });
        return;
      }
      this.instance = instance;
      if (typeof navigator !== 'undefined') this.network(navigator.onLine);
      const state = await tauriInvoke<ConnectionState>('sse_get_state', {
        instance,
      });
      if (!current() || this.instance !== instance) return;
      this.sink.onState(state);
      if (state === 'open') {
        await tauriInvoke('sse_replay_hello', { instance });
      }
    } catch {
      if (current()) this.stop();
      else this.dispose(listeners);
    }
  }

  private network(online: boolean): void {
    if (!this.installed || this.instance === null) return;
    void tauriInvoke('sse_net', { instance: this.instance, online });
  }

  stop(): void {
    if (!this.installed) return;
    this.installed = false;
    ++this.epoch;
    const instance = this.instance;
    this.instance = null;
    this.dispose(this.unlisteners);
    this.unlisteners = [];
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      window.removeEventListener('offline', this.onOffline);
    }
    if (instance !== null) void tauriInvoke('sse_stop', { instance });
    this.sink.onState('closed');
  }

  override retryNow(): void {
    this.sink.onReconnectIn(null);
    void this.control(false).catch(() => {
      /* IPC already reports the failure. */
    });
  }

  override forceReconnect(): void {
    void this.control(true).catch(() => {
      /* IPC already reports the failure. */
    });
  }

  private async control(force: boolean): Promise<void> {
    const instance = this.instance;
    const epoch = this.epoch;
    if (!this.installed || instance === null) return;
    const next = await tauriInvoke<number>('sse_retry', { instance, force });
    if (!next) return;
    if (!this.current(epoch) || this.instance !== instance) {
      if (next !== instance) void tauriInvoke('sse_stop', { instance: next });
      return;
    }
    this.instance = next;
  }
}
