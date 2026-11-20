import { HttpClient, HttpContext, HttpEventType, HttpHeaders } from '@angular/common/http';
import { Observable, firstValueFrom, fromEvent, takeUntil, tap, filter, map } from 'rxjs';
import { apiPrefix } from './constants';
import { REPLAY_SAFE } from '../request-context';
import type { StandardResponse } from './model';
import type { UploadPartIdentity, UploadProgressHandler } from './upload-transport';

interface UploadState {
  id: string;
  totalBytes: number;
  offset: number | null;
  chunkSize: number;
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  phase?: 'UPLOADING' | 'COMPLETING';
  result?: Record<string, unknown>;
}

/** Browser chunk transport. Displayed bytes never authorize a resumed write. */
export class WebUploadTransport {
  constructor(private readonly http: HttpClient) {}

  upload<T>(file: File, identity: UploadPartIdentity, progress?: UploadProgressHandler): Observable<StandardResponse<T>> {
    return new Observable(subscriber => {
      const abort = new AbortController();
      void this.run<T>(file, identity, abort.signal, (loaded, total) => {
        if (!subscriber.closed) progress?.(loaded, total);
      }).then(result => { subscriber.next(result); subscriber.complete(); }, error => subscriber.error(error));
      return () => abort.abort();
    });
  }

  private async run<T>(file: File, identity: UploadPartIdentity, signal: AbortSignal, progress: UploadProgressHandler): Promise<StandardResponse<T>> {
    const read = <R>(request: Observable<R>) => {
      if (signal.aborted) return Promise.reject(new Error('Upload cancelled'));
      return firstValueFrom(request.pipe(takeUntil(fromEvent(signal, 'abort'))));
    };
    const context = () => new HttpContext().set(REPLAY_SAFE, true);
    const init = await read(this.http.post<StandardResponse<UploadState>>(`${apiPrefix()}/uploads/resumable/init`, {
      ...identity, originalName: file.name || 'attachment',
      mimeType: file.type || 'application/octet-stream', totalBytes: file.size,
    }, { context: context() }));
    if (init.code !== 0 || !init.data) throw new Error(init.message || 'upload init failed');
    const taskId = init.data.id;
    if (typeof taskId !== 'string' || !/^[1-9][0-9]{0,18}$/.test(taskId) || BigInt(taskId) > 9223372036854775807n)
      throw new Error('upload init returned invalid task id');
    const url = `${apiPrefix()}/uploads/resumable/${encodeURIComponent(taskId)}`;
    const validate = (value: UploadState): UploadState => {
      if (value.id !== taskId || !['PENDING', 'COMPLETED', 'FAILED'].includes(value.status) ||
        (value.status === 'PENDING' ? value.phase !== 'UPLOADING' && value.phase !== 'COMPLETING' : 'phase' in value))
        throw new Error('invalid upload state');
      if (value.offset != null && (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > file.size))
        throw new Error('invalid upload offset');
      if (value.phase === 'UPLOADING' && (value.offset == null || !Number.isSafeInteger(value.chunkSize) || value.chunkSize <= 0))
        throw new Error('upload progress unavailable');
      if (value.status === 'COMPLETED' && !value.result) throw new Error('completed upload omitted result');
      return value;
    };
    validate(init.data);
    const success = (result: unknown): StandardResponse<T> => ({ code: 0, message: 'success', data: result as T });
    if (init.data.status === 'COMPLETED') return success(init.data.result);
    let state = await read(this.http.get<StandardResponse<UploadState>>(url, { context: context() }));
    if (state.code !== 0 || !state.data) throw new Error(state.message || 'upload status failed');
    let current = validate(state.data);
    if (current.status === 'FAILED') {
      state = await read(this.http.post<StandardResponse<UploadState>>(`${url}/retry`, {}, { context: context() }));
      if (state.code !== 0 || !state.data) throw new Error(state.message || 'upload retry failed');
      current = validate(state.data);
    }
    if (current.offset != null) progress(current.offset, file.size);
    while (current.phase === 'UPLOADING' && current.offset! < file.size) {
      const offset = current.offset!;
      const end = Math.min(offset + current.chunkSize, file.size);
      const chunk = file.slice(offset, end);
      const response = await read(this.http.put<StandardResponse<UploadState>>(url, chunk, {
        observe: 'events', reportProgress: true,
        headers: new HttpHeaders({ 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${offset}-${end - 1}/${file.size}` }),
      }).pipe(
        tap(event => { if (event.type === HttpEventType.UploadProgress) progress(offset + Math.min(chunk.size, Math.max(0, event.loaded)), file.size); }),
        filter(event => event.type === HttpEventType.Response),
        map(event => { if (!event.body) throw new Error('upload chunk returned an empty response'); return event.body; }),
      ));
      if (response.code !== 0 || !response.data) throw new Error(response.message || 'upload chunk failed');
      current = validate(response.data);
      if (current.phase === 'UPLOADING' && current.offset !== end) throw new Error('upload chunk returned unexpected offset');
    }
    if (current.status === 'COMPLETED') return success(current.result);
    if (current.status !== 'PENDING') throw new Error(`upload is ${current.status}`);
    const completed = await read(this.http.post<StandardResponse<UploadState>>(`${url}/complete`, {}, { context: context() }));
    if (completed.code !== 0 || !completed.data?.result) throw new Error(completed.message || 'upload complete failed');
    const final = validate(completed.data);
    if (final.phase !== 'COMPLETING' && final.status !== 'COMPLETED') throw new Error('invalid upload complete state');
    return success(final.result);
  }
}
