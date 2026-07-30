import { inject, Injectable } from '@angular/core';
import {
  FetchBackend,
  HttpBackend,
  HttpErrorResponse,
  HttpEvent,
  HttpHeaders,
  HttpRequest,
  HttpResponse,
} from '@angular/common/http';
import { Observable, catchError, from, throwError } from 'rxjs';
import { isTauri, tauriInvoke } from './services/runtime';
import { REPLAY_SAFE } from './request-context';

/**
 * The webview→backend HTTP transport (custom `HttpBackend`).
 *
 * Browser: delegate to Angular's stock `FetchBackend` — same-origin fetch, the httpOnly session cookie
 * authenticates. Under the Tauri shell (desktop + Android):
 *  - `/api/v1/...` is routed through the Rust `api_request` IPC command instead of `fetch()`. Android's
 *    Chromium system WebView rejects non-standard schemes in `fetch()`, so the old `api://localhost`
 *    custom-scheme proxy could not be fetched there (every API call 404'd at the fetch layer); IPC bypasses
 *    the webview fetch entirely. Routing through Rust ALSO lets Rust own the session token — `api_request`
 *    injects `Authorization: Bearer` from its held `ProxyState.token`, so JS never touches the token (the
 *    JS `AuthInterceptor` no longer sets a Bearer).
 *  - The media proxy URL (`media://localhost/...` on desktop, `http://media.localhost/...` on
 *    Android/Windows) is routed through the Rust `media_request` IPC command. The platform-specific URL is
 *    only a WebView representation detail; Angular HTTP treats both forms as the same media transport.
 *
 * This backend is the unambiguous terminus of the interceptor chain (runs after correlationId /
 * AuthInterceptor / httpTrace), so those interceptors still see the request + the response/error this
 * backend produces (the `HttpErrorResponse` thrown on non-2xx / IPC failure keeps `on401` + the trace
 * classification working).
 */
interface ApiRequestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** `media_request` result: raw image bytes (serde `Vec<u8>` → a JSON number array) + the content type. */
interface MediaRequestResult {
  status: number;
  contentType: string | null;
  body: number[];
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
  /** Stock fetch backend for the browser path + non-`/api/v1` requests under Tauri (e.g. `media://`). */
  private readonly fetchBackend = inject(FetchBackend);

  handle(req: HttpRequest<any>): Observable<HttpEvent<any>> {
    if (!isTauri()) return this.fetchBackend.handle(req);
    const url = req.urlWithParams;
    if (url.startsWith('/api/v1')) {
      return from(this.invoke(req)).pipe(
        catchError((err) => throwError(() => this.toError(err, req))),
      );
    }
    const mediaPath = mediaProxyPath(url);
    if (mediaPath !== null) {
      // Keep both WebView URL representations behind the same authenticated Rust media transport.
      return from(this.invokeMedia(req, mediaPath)).pipe(
        catchError((err) => throwError(() => this.toError(err, req))),
      );
    }
    return this.fetchBackend.handle(req);
  }

  /** Perform the IPC round-trip and map the result to an `HttpResponse`, or throw an `HttpErrorResponse`
   *  for non-2xx (so the trace interceptor + `AuthInterceptor.on401` keep working). */
  private async invoke(req: HttpRequest<any>): Promise<HttpEvent<any>> {
    const { body, contentType } = await this.serializeBody(req.body);
    const headers = this.pickHeaders(req.headers);
    if (contentType && !headers['content-type']) headers['content-type'] = contentType;
    const r = await tauriInvoke<ApiRequestResult>('api_request', {
      method: req.method,
      path: req.urlWithParams,
      headers,
      body,
      replaySafe:
        ['GET', 'HEAD', 'OPTIONS'].includes(req.method.toUpperCase()) ||
        req.context.get(REPLAY_SAFE),
    });
    const respHeaders = new HttpHeaders(r.headers);
    const parsed = this.parseBody(r.body, req.responseType);
    if (r.status >= 200 && r.status < 300) {
      return new HttpResponse({ body: parsed, headers: respHeaders, status: r.status, url: req.url });
    }
    // Non-2xx → HttpErrorResponse (status/headers/error/url/message) so downstream error handling matches
    // the stock backend's shape exactly.
    throw new HttpErrorResponse({
      status: r.status,
      headers: respHeaders,
      url: req.url,
      error: parsed,
    });
  }

  /** Call the Rust `media_request` command with a normalized `/uploads/...` path (it re-prepends the live
   *  api_origin + injects the Bearer), and wrap the returned bytes per the request's `responseType`. */
  private async invokeMedia(req: HttpRequest<any>, path: string): Promise<HttpEvent<any>> {
    const r = await tauriInvoke<MediaRequestResult>('media_request', { path });
    const bytes = new Uint8Array(r.body);
    const headers = new HttpHeaders(r.contentType ? { 'content-type': r.contentType } : {});
    if (r.status >= 200 && r.status < 300) {
      const body = this.parseMediaBody(bytes, r.contentType ?? undefined, req.responseType);
      return new HttpResponse({ body, headers, status: r.status, url: req.url });
    }
    throw new HttpErrorResponse({ status: r.status, headers, url: req.url, error: bytes });
  }

  /** Wrap raw media bytes per `responseType`. The avatar cache requests `'blob'` (with the content type so
   *  the cached Blob round-trips its MIME). */
  private parseMediaBody(bytes: Uint8Array, contentType: string | undefined, responseType: string): unknown {
    switch (responseType) {
      case 'arraybuffer': return bytes.buffer;
      case 'text': return new TextDecoder().decode(bytes);
      case 'blob': return new Blob([bytes.slice()], contentType ? { type: contentType } : undefined);
      case 'json':
      default:
        try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
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
  private async serializeBody(body: unknown): Promise<{ body: Uint8Array | undefined; contentType?: string }> {
    if (body == null) return { body: undefined };
    if (body instanceof Uint8Array) return { body };
    if (body instanceof ArrayBuffer) return { body: new Uint8Array(body) };
    if (body instanceof Blob) return { body: new Uint8Array(await body.arrayBuffer()), contentType: body.type || undefined };
    if (body instanceof URLSearchParams) {
      return { body: new TextEncoder().encode(body.toString()), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
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
    return { body: new TextEncoder().encode(text), contentType: isString ? 'text/plain' : 'application/json' };
  }

  /** Build a `multipart/form-data` body from a `FormData` (Android uploads reach the backend as FormData —
   *  the old `api://` proxy forwarded the buffered multipart Tauri assembled; with IPC we assemble it in
   *  JS). Each File/Blob part is read async. The boundary is random per request. */
  private async serializeMultipart(fd: FormData): Promise<{ body: Uint8Array; contentType: string }> {
    const boundary = '----soms-boundary-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
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
        parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
        parts.push(enc.encode(String(value)));
        parts.push(crlf);
      }
    }
    parts.push(enc.encode(`--${boundary}--\r\n`));
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return { body: out, contentType: `multipart/form-data; boundary=${boundary}` };
  }

  /** Parse the UTF-8 response body per the request's `responseType`.
   *
   *  Only `/api/v1` reaches here — the media blob path has its own `parseMediaBody` over RAW bytes — and
   *  every `/api/v1` response is JSON (the default `responseType`), so only `json` + `text` are supported.
   *  Binary responseTypes are DELIBERATELY not handled: `api_request` returns the body as a Rust `String`
   *  (`String::from_utf8_lossy`), so a binary response is already lossy at the transport, and re-encoding
   *  via `new TextEncoder().encode(text)` would NOT recover the original bytes — a binary `/api/v1`
   *  endpoint would need a byte-returning command (like `media_request`), not this path. A stray
   *  `blob`/`arraybuffer` request therefore falls through to `JSON.parse`, which throws loudly instead of
   *  silently returning corrupted bytes. An empty body → null (e.g. 204 No Content). */
  private parseBody(text: string, responseType: string): unknown {
    if (responseType === 'text') return text;
    return text.length === 0 ? null : JSON.parse(text);
  }

  /** Map an IPC failure (api_request rejected — backend unreachable / timeout) to a status-0
   *  `HttpErrorResponse` (classified `[http] network` by the trace interceptor, parity with the old
   *  api:// 502/504 → fetch status 0). A non-2xx already thrown as HttpErrorResponse passes through. */
  private toError(err: unknown, req: HttpRequest<any>): HttpErrorResponse {
    if (err instanceof HttpErrorResponse) return err;
    return new HttpErrorResponse({
      status: 0,
      url: req.url,
      error: err,
    });
  }
}
