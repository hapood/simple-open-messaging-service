import {
  HttpErrorResponse,
  HttpResponse,
  type HttpInterceptorFn,
} from '@angular/common/http';
import { defer, of, throwError, map } from 'rxjs';
import { avatarBlobDataUrl } from '../app/services/profile-avatar-bytes';

/** Mock-only HTTP escape hatches used directly by shared presentation components.
 * Unknown API calls fail locally rather than contacting a real server from the playground. */
export const playgroundHttp: HttpInterceptorFn = (request, next) => {
  const path = new URL(request.url, 'http://playground.invalid').pathname;
  if (!path.includes('/api/v1/')) return next(request);
  if (path.endsWith('/media-status')) {
    const { seqs } = request.body as { seqs: number[] };
    return of(
      new HttpResponse({
        body: {
          code: 0,
          message: 'ok',
          data: {
            statuses: seqs.map((seq) => ({ seq, status: 'ready' })),
          },
        },
      }),
    );
  }
  if (path.endsWith('/upload/avatar') && request.body instanceof FormData) {
    const file = request.body.get('file');
    if (file instanceof Blob)
      return defer(() => avatarBlobDataUrl(file)).pipe(
        map(
          (avatar) =>
            new HttpResponse({
              body: { code: 0, message: 'ok', data: { avatar } },
            }),
        ),
      );
  }
  if (path.endsWith('/config')) {
    return of(
      new HttpResponse({
        body: {
          code: 0,
          message: 'ok',
          data: {
            registrationOpen: true,
            loginMethods: [
              { key: 'password', disabled: false },
              { key: 'otp', disabled: false },
              { key: 'qr', disabled: false },
            ],
            defaultLoginMethod: 'password',
          },
        },
      }),
    );
  }
  if (path.endsWith('/auth/login') || path.endsWith('/auth/otp')) {
    return of(
      new HttpResponse({
        body: {
          code: 0,
          message: 'ok',
          data: {
            token: 'mock-playground-token',
            mustChangePassword: false,
          },
        },
      }),
    );
  }
  if (path.endsWith('/auth/qr/create')) {
    return of(
      new HttpResponse({
        body: {
          code: 0,
          message: 'ok',
          data: {
            qrToken: 'playground-mock-qr-token',
            expiresAt: Date.now() + 120000,
          },
        },
      }),
    );
  }
  if (path.endsWith('/auth/qr/poll')) {
    return of(
      new HttpResponse({
        body: {
          code: 0,
          message: 'ok',
          data: {
            status: 'pending',
          },
        },
      }),
    );
  }
  return throwError(
    () =>
      new HttpErrorResponse({
        status: 501,
        statusText: 'Unsupported playground API',
        url: request.url,
      }),
  );
};
