import { inject, Injectable } from '@angular/core';
import {
  FetchBackend,
  HttpBackend,
  HttpXhrBackend,
  HttpErrorResponse,
  HttpEvent,
  HttpEventType,
  HttpHeaders,
  HttpHeaderResponse,
  ɵHTTP_FETCH_MAX_RESPONSE_SIZE as HTTP_FETCH_MAX_RESPONSE_SIZE,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Observable } from 'rxjs';
import { isTauri, tauriInvoke } from './services/runtime';
import { withFetchApiDeadline } from './fetch-api-deadline';
import { withXhrUploadDeadline } from './xhr-upload-deadline';
import { REPLAY_SAFE, REQUEST_SCOPE } from './request-context';
import { browserShortRequestScheduler } from './lib/bounded-request-scheduler';
import { fetchShortText } from './lib/short-fetch';

/** Short JSON API calls only. Bulk transfer, progress transports and event streams
 * must not occupy the lane used by interactive API operations. */
export function isShortApiRequest(req: HttpRequest<unknown>): boolean {
  const path = req.url.split('?')[0];
  return (
    path.startsWith('/api/v1/') &&
    req.responseType === 'json' &&
    !req.reportProgress &&
    !req.reportUploadProgress &&
    !req.reportDownloadProgress &&
    !req.headers.get('accept')?.includes('text/event-stream') &&
    !/\/api\/v1\/(?:upload|uploads)(?:\/|$)/.test(path) &&
    !(req.body instanceof Blob) &&
    !(req.body instanceof FormData) &&
    !(req.body instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(req.body)
  );
}

/**
 * The webview→backend HTTP transport (custom `HttpBackend`).
 *
 * Browser: short JSON API calls share bounded promise-backed fetch admission; other requests
 * delegate to Angular's stock backends. The httpOnly session cookie authenticates.
 * Under the Tauri shell (desktop + Android):
 *  - `/api/v1/...` and media URLs (`media://localhost/...`, `http://media.localhost/...`) are routed
 *    through the unified Rust `http_request` IPC command instead of `fetch()`. Android's Chromium system
 *    WebView rejects non-standard schemes in `fetch()`, and routing through Rust lets Rust own the
 *    session token (`http_request` injects `Authorization: Bearer` from its held `ProxyState.token`).
 *
 * This backend is the unambiguous terminus of the interceptor chain (runs after correlationId /
 * AuthInterceptor / httpTrace), so those interceptors still see the request + the response/error this
 * backend produces (the `HttpErrorResponse` thrown on non-2xx / IPC failure keeps `on401` + the trace
 * classification working).
 */
interface HttpResponseResult {
  status: number;
  headers: Record<string, string>;
  text?: string | null;
  bytes?: number[] | null;
}

const MEDIA_PROXY_PREFIXES = [
  'media://localhost',
  'http://media.localhost',
] as const;

function mediaProxyPath(url: string): string | null {
  const prefix = MEDIA_PROXY_PREFIXES.find(
    (candidate) =>
      url === candidate ||
      url.startsWith(`${candidate}/`) ||
      url.startsWith(`${candidate}?`),
  );
  if (!prefix) return null;
  const suffix = url.slice(prefix.length);
  if (!suffix || suffix.startsWith('?')) return `/${suffix}`;
  return suffix;
}

@Injectable()
export class TauriHttpBackend implements HttpBackend {
  /** Stock fetch backend for the browser path + non-routed requests under Tauri. */
  private readonly fetchBackend = inject(FetchBackend);
  private readonly xhrBackend = inject(HttpXhrBackend);
  private readonly maxResponseSize = inject(HTTP_FETCH_MAX_RESPONSE_SIZE);

  handle(req: HttpRequest<any>): Observable<HttpEvent<any>> {
    if (!isTauri()) {
      if (isShortApiRequest(req)) {
        return browserShortRequestScheduler.schedule<HttpEvent<unknown>>(
          (signal, emit) => this.fetchShortRequest(req, signal, emit),
        );
      }
      return req.reportProgress &&
        req.method === 'PUT' &&
        req.url.includes('/uploads/resumable/')
        ? withXhrUploadDeadline(this.xhrBackend.handle(req), req.urlWithParams)
        : req.url.startsWith('/api/v1/')
          ? withFetchApiDeadline(
              this.fetchBackend.handle(req.clone({ reportProgress: true })),
              req.urlWithParams,
            )
          : this.fetchBackend.handle(req);
    }
    const url = req.urlWithParams;
    let path: string | null = null;
    if (url.startsWith('/api/v1')) {
      path = url;
    } else {
      path = mediaProxyPath(url);
    }
    if (path !== null) {
      const targetPath = path;
      return new Observable<HttpEvent<any>>((subscriber) => {
        const reqId =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        let finished = false;
        let dispatched = false;
        const cancellation = new AbortController();

        this.invoke(req, targetPath, reqId, cancellation.signal, () => {
          dispatched = true;
        })
          .then((event) => {
            finished = true;
            subscriber.next(event);
            subscriber.complete();
          })
          .catch((err) => {
            finished = true;
            subscriber.error(this.toError(err, req));
          });

        return () => {
          if (!finished) {
            cancellation.abort();
            if (dispatched)
              void tauriInvoke('cancel_http_request', { reqId }).catch(
                () => undefined,
              );
          }
        };
      });
    }
    return this.fetchBackend.handle(req);
  }

  /** Own the fetch promise through the last body read. Angular's FetchBackend exposes only
   * Observable teardown, which cannot acknowledge when an aborted fetch actually settles. */
  private async fetchShortRequest(
    req: HttpRequest<unknown>,
    signal: AbortSignal,
    emit: (event: HttpEvent<unknown>) => void,
  ): Promise<HttpResponse<unknown>> {
    try {
      const headers = new Headers();
      for (const name of req.headers.keys())
        headers.set(name, req.headers.getAll(name)!.join(','));
      if (!headers.has('accept'))
        headers.set('accept', 'application/json, text/plain, */*');
      const contentType = req.detectContentTypeHeader();
      if (contentType && !headers.has('content-type'))
        headers.set('content-type', contentType);
      const { response, text } = await fetchShortText(
        req.urlWithParams,
        {
          method: req.method,
          headers,
          body: req.serializeBody(),
          credentials: req.withCredentials ? 'include' : req.credentials,
          cache: req.cache,
          mode: req.mode,
          redirect: req.redirect,
          referrer: req.referrer,
          referrerPolicy: req.referrerPolicy,
          integrity: req.integrity,
          keepalive: req.keepalive,
          priority: req.priority,
        },
        signal,
        {
          timeout: req.timeout,
          maxResponseSize: this.maxResponseSize,
          onSent: () => emit({ type: HttpEventType.Sent }),
          onResponse: (response) =>
            emit(
              new HttpHeaderResponse({
                headers: new HttpHeaders(response.headers),
                status: response.status,
                statusText: response.statusText,
                url: response.url || req.urlWithParams,
              }),
            ),
          onDownloadProgress: (loaded, total) =>
            emit({ type: HttpEventType.DownloadProgress, loaded, total }),
        },
      );
      const responseHeaders = new HttpHeaders(response.headers);
      const url = response.url || req.urlWithParams;
      const normalized = text.replace(/^\)\]\}',?\n/, '');
      let body: unknown = normalized;
      try {
        body = normalized ? JSON.parse(normalized) : null;
      } catch (error) {
        if (response.ok)
          throw new HttpErrorResponse({
            error,
            headers: responseHeaders,
            status: response.status,
            statusText: response.statusText,
            url,
          });
      }
      if (!response.ok)
        throw new HttpErrorResponse({
          error: body,
          headers: responseHeaders,
          status: response.status,
          statusText: response.statusText,
          url,
          redirected: response.redirected,
          responseType: response.type,
        });
      return new HttpResponse({
        body,
        headers: responseHeaders,
        status: response.status,
        statusText: response.statusText,
        url,
        redirected: response.redirected,
        responseType: response.type,
      });
    } catch (error) {
      throw this.toError(error, req);
    }
  }

  /** Perform the unified IPC round-trip and map the result to an `HttpResponse`, or throw an `HttpErrorResponse`
   *  for non-2xx (so the trace interceptor + `AuthInterceptor.on401` keep working). */
  private async invoke(
    req: HttpRequest<any>,
    path: string,
    reqId: string,
    signal: AbortSignal,
    onDispatch: () => void,
  ): Promise<HttpEvent<any>> {
    const isBinary =
      req.responseType === 'blob' || req.responseType === 'arraybuffer';
    const { body, contentType } = await this.serializeBody(req.body);
    const headers = this.pickHeaders(req.headers);
    if (contentType && !headers['content-type'])
      headers['content-type'] = contentType;
    signal.throwIfAborted();
    await tauriInvoke<HttpResponseResult>('http_request', {
      reqId,
      method: req.method,
      path,
      headers: {},
      binary: false,
      replaySafe: false,
      prepareOnly: true,
    });
    // Cancellation during the acknowledgement must cancel the reserved token, not
    // race a not-yet-registered execution command. Rust rejects expired reservations.
    onDispatch();
    if (signal.aborted) {
      await tauriInvoke('cancel_http_request', { reqId });
      signal.throwIfAborted();
    }
    const r = await tauriInvoke<HttpResponseResult>('http_request', {
      prepared: true,
      reqId,
      scope: req.context.get(REQUEST_SCOPE),
      shortRequest: isShortApiRequest(req),
      method: req.method,
      path,
      headers,
      body,
      binary: isBinary,
      replaySafe:
        ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()) ||
        req.context.get(REPLAY_SAFE),
    });
    const respHeaders = new HttpHeaders(r.headers);
    const contentTypeHeader =
      r.headers['content-type'] || r.headers['Content-Type'];
    const isSuccess = r.status >= 200 && r.status < 300;
    const parsed = isSuccess
      ? this.parseResponseBody(r, req.responseType, contentTypeHeader)
      : this.parseErrorResponseBody(r, req.responseType, contentTypeHeader);
    if (isSuccess) {
      return new HttpResponse({
        body: parsed,
        headers: respHeaders,
        status: r.status,
        url: req.url,
      });
    }
    throw new HttpErrorResponse({
      status: r.status,
      headers: respHeaders,
      url: req.url,
      error: parsed,
    });
  }

  private parseResponseBody(
    r: HttpResponseResult,
    responseType: string,
    contentType?: string,
  ): unknown {
    if (r.bytes != null) {
      const u8 = new Uint8Array(r.bytes);
      switch (responseType) {
        case 'arraybuffer':
          return u8.buffer;
        case 'blob':
          return new Blob(
            [u8.slice()],
            contentType ? { type: contentType } : undefined,
          );
        case 'text':
          return new TextDecoder().decode(u8);
        case 'json':
        default:
          try {
            return JSON.parse(new TextDecoder().decode(u8));
          } catch {
            return null;
          }
      }
    }
    const text = r.text ?? '';
    if (responseType === 'text') return text;
    return text.length === 0 ? null : JSON.parse(text);
  }

  private parseErrorResponseBody(
    r: HttpResponseResult,
    responseType: string,
    contentType?: string,
  ): unknown {
    if (r.bytes != null) {
      return this.parseResponseBody(r, responseType, contentType);
    }
    const text = r.text ?? '';
    if (responseType === 'text') return text;
    try {
      return text.length === 0 ? null : JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Forward only the headers the backend needs; `authorization` is never forwarded — Rust injects the
   *  Bearer from `ProxyState.token` (JS does not handle the token). */
  private pickHeaders(h: HttpHeaders): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of [
      'content-type',
      'accept',
      'accept-language',
      'range',
      'x-request-id',
      // Upload routes use this correlation key to promote the already-staged media intent into a Message.
      // Dropping it makes the bytes upload successfully but leaves the stage pending, which the UI reports
      // as a failed send. It is an opaque client UUID, not a credential.
      'x-client-message-id',
    ]) {
      const v = h.get(name);
      if (v !== null) out[name] = v;
    }
    return out;
  }

  /** Serialize the request body to bytes for the IPC call. Synthesizes a `content-type` that MIRRORS
   *  Angular's `HttpRequest.detectContentTypeHeader()` for each body type, so this backend behaves like the
   *  stock `FetchBackend` it replaces (reqwest never auto-sets a Content-Type for a raw byte body):
   *    Blob → `blob.type` (Angular returns `blob.type || null`, so an untyped Blob stays unset),
   *    URLSearchParams → urlencoded, FormData → a synthesized multipart boundary (Angular leaves multipart
   *    to the browser, which the IPC path can't reach), objects → `application/json`, strings → `text/plain`. */
  private async serializeBody(
    body: unknown,
  ): Promise<{ body: Uint8Array | undefined; contentType?: string }> {
    if (body == null) return { body: undefined };
    if (body instanceof Uint8Array) return { body };
    if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) };
    if (body instanceof Blob)
      return {
        body: new Uint8Array(await body.arrayBuffer()),
        contentType: body.type || undefined,
      };
    if (body instanceof URLSearchParams) {
      return {
        body: new TextEncoder().encode(body.toString()),
        contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
      };
    }
    if (body instanceof FormData) {
      return this.serializeMultipart(body);
    }
    // Objects/arrays/primitives → JSON; a raw string body passes through verbatim. The content-type is
    // synthesized to MIRROR the stock `FetchBackend`, which applies `HttpRequest.detectContentTypeHeader()`
    // — `application/json` for objects/arrays/numbers/booleans, `text/plain` for strings. reqwest does NOT
    // auto-set a Content-Type for a raw byte body, so without this the IPC POST leaves Rust with no
    // Content-Type and Fastify rejects the JSON body with 415 (every `/api/v1` POST/PUT/PATCH under Tauri).
    const isString = typeof body === 'string';
    const text = isString ? body : JSON.stringify(body);
    return {
      body: new TextEncoder().encode(text),
      contentType: isString ? 'text/plain' : 'application/json',
    };
  }

  /** Build a `multipart/form-data` body from a `FormData` (Android uploads reach the backend as FormData —
   *  the old `api://` proxy forwarded the buffered multipart Tauri assembled; with IPC we assemble it in
   *  JS). Each File/Blob part is read async. The boundary is random per request. */
  private async serializeMultipart(
    fd: FormData,
  ): Promise<{ body: Uint8Array; contentType: string }> {
    const boundary =
      '----soms-boundary-' +
      Math.random().toString(36).slice(2) +
      Date.now().toString(36);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    const crlf = enc.encode('\r\n');
    // FormData isn't iterable in this lib config (no dom.iterable) — collect via forEach, then process.
    const entries: Array<[string, FormDataEntryValue]> = [];
    fd.forEach((value, key) => entries.push([key, value]));
    for (const [name, value] of entries) {
      parts.push(enc.encode(`--${boundary}\r\n`));
      if (value instanceof Blob) {
        const file = value as File;
        const disposition = file.name
          ? `Content-Disposition: form-data; name="${name}"; filename="${file.name}"\r\n`
          : `Content-Disposition: form-data; name="${name}"\r\n`;
        const type = file.type || 'application/octet-stream';
        parts.push(enc.encode(`${disposition}Content-Type: ${type}\r\n\r\n`));
        parts.push(new Uint8Array(await file.arrayBuffer()));
        parts.push(crlf);
      } else {
        parts.push(
          enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`),
        );
        parts.push(enc.encode(String(value)));
        parts.push(crlf);
      }
    }
    parts.push(enc.encode(`--${boundary}--\r\n`));
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return {
      body: out,
      contentType: `multipart/form-data; boundary=${boundary}`,
    };
  }

  /** Map an IPC failure (http_request rejected — backend unreachable / timeout) to a status-0
   *  `HttpErrorResponse` (classified `[http] network` by the trace interceptor, parity with the old
   *  api:// 502/504 → fetch status 0). A non-2xx already thrown as HttpErrorResponse passes through. */
  private toError(err: unknown, req: HttpRequest<any>): HttpErrorResponse {
    if (err instanceof HttpErrorResponse) return err;
    return new HttpErrorResponse({
      status: 0,
      url: req.urlWithParams,
      error: err,
    });
  }
}
