import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpContext } from '@angular/common/http';
import { firstValueFrom, timeout } from 'rxjs';
import { apiPrefix } from './constants';
import { SUPPRESS_HTTP_ERROR_TOAST } from '../request-context';
import type { components } from './api-types';

export type PushProbeStatus = components['schemas']['PushProbeStatusDto'];

/** Web and Android share the authenticated session's short-lived delivery probe. */
@Injectable({ providedIn: 'root' })
export class PushProbeService {
  private readonly http = inject(HttpClient);

  create(): Promise<PushProbeStatus> {
    return this.request();
  }

  get(probeId: string, timeoutMs = 10000): Promise<PushProbeStatus> {
    return this.request(probeId, timeoutMs);
  }

  private async request(
    probeId?: string,
    timeoutMs = 20000,
  ): Promise<PushProbeStatus> {
    const url = `${apiPrefix()}/devices/push-probes`;
    const options = {
      context: new HttpContext().set(SUPPRESS_HTTP_ERROR_TOAST, true),
    };
    type Envelope = { code: number; message: string; data?: PushProbeStatus };
    const response = await firstValueFrom(
      (probeId
        ? this.http.get<Envelope>(
            `${url}/${encodeURIComponent(probeId)}`,
            options,
          )
        : this.http.post<Envelope>(url, {}, options)
      ).pipe(timeout(timeoutMs)),
    );
    if (response.code !== 0 || !response.data)
      throw new Error(response.message || 'Push health check failed');
    return response.data;
  }
}
