import { HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { EMPTY } from 'rxjs';
import { correlationIdInterceptor } from './correlation-id.interceptor';

/**
 * correlationIdInterceptor — stamps an `X-Request-Id` on every outgoing request for end-to-end
 * correlation with the server's pino `req.id`. Pure unit: a stub `HttpHandlerFn` captures the request
 * the interceptor forwards so we can assert on its headers.
 */
describe('correlationIdInterceptor (X-Request-Id correlation)', () => {
  /** A next-handler that records the request it receives and completes without emitting. */
  function capturingNext(captured: HttpRequest<unknown>[]): HttpHandlerFn {
    return (r) => {
      captured.push(r);
      return EMPTY;
    };
  }

  it('stamps an X-Request-Id when the request does not already carry one', () => {
    const captured: HttpRequest<unknown>[] = [];
    correlationIdInterceptor(new HttpRequest('GET', '/api/v1/messages', {}), capturingNext(captured)).subscribe();
    expect(captured.length).toBe(1);
    expect(captured[0].headers.has('X-Request-Id')).toBeTrue();
    // RFC 4122 v4 textual form: 8-4-4-4-12 hex.
    expect(captured[0].headers.get('X-Request-Id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('preserves a caller-supplied X-Request-Id (never clobbers)', () => {
    const req = new HttpRequest('GET', '/api/v1/messages', {}).clone({ setHeaders: { 'X-Request-Id': 'caller-supplied-1' } });
    const captured: HttpRequest<unknown>[] = [];
    correlationIdInterceptor(req, capturingNext(captured)).subscribe();
    expect(captured[0].headers.get('X-Request-Id')).toBe('caller-supplied-1');
  });
});
