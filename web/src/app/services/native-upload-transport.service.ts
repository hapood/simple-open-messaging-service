import { Observable } from 'rxjs';
import { tauriInvoke } from './runtime';
import type { StandardResponse } from './model';
import type { UploadPartIdentity, UploadProgressHandler } from './upload-transport';

export interface NativeUploadResource {
  path: string;
  name: string;
  mimeType: string;
  size: number;
}
interface Progress { loaded: number; total: number }

/** Each native invocation owns its progress channel and result; no global callback registry. */
export class NativeUploadTransport {
  constructor(private readonly runtime = {
    invoke: tauriInvoke,
    channel: (receive: (event: Progress) => void): unknown => {
      const Channel = window.__TAURI__?.core?.Channel;
      if (!Channel) throw new Error('Native IPC Channel is unavailable');
      return new Channel<Progress>(receive);
    },
  }) {}

  prepare(clientMessageId: string, sources: readonly { partId: string; path: string; size: number }[]): Promise<void> {
    return this.runtime.invoke('prepare_native_upload_sources', { clientMessageId, sources });
  }

  release(clientMessageId: string): Promise<void> {
    return this.runtime.invoke('release_native_upload_sources', { clientMessageId });
  }

  upload<T>(resource: NativeUploadResource, identity: UploadPartIdentity, progress?: UploadProgressHandler): Observable<StandardResponse<T>> {
    return new Observable(subscriber => {
      let settled = false;
      const channel = this.runtime.channel(event => {
        if (!subscriber.closed) progress?.(Math.max(0, event.loaded), Math.max(0, event.total));
      });
      void this.runtime.invoke<StandardResponse<T>>('upload_stream_file', {
        path: resource.path, filename: resource.name, mime: resource.mimeType, size: resource.size,
        fields: { partId: identity.partId, position: String(identity.position), intent: identity.intent },
        clientMessageId: identity.clientMessageId, progress: channel,
      }).then(result => {
        settled = true;
        subscriber.next(result);
        subscriber.complete();
      }, error => { settled = true; subscriber.error(error); });
      return () => {
        if (!settled) void this.runtime.invoke('cancel_upload', { clientMessageId: identity.clientMessageId }).catch(() => undefined);
      };
    });
  }
}
