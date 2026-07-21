import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { apiPrefix } from './constants';
import type { StandardResponse } from './model';

/** The action-report body — mirrors the backend ReportActionDto (the fields the surface has). */
export interface NotifActionReport {
  tag: string;
  actionId: string;
  threadIds?: number[];
  threadId?: number;
  seq?: number;
  replyText?: string;
}

/**
 * Reports a notification action (button tap / inline reply) back to `POST /notifications/action` — the
 * foreground's round-trip closure for the descriptor's `actions[]`. The in-app popup ({@link NotifPopupComponent})
 * uses this; the Web Push SW does its own same-origin `fetch` (it lives outside Angular). Best-effort:
 * errors are swallowed (the popup dismisses optimistically; a failed POST just means the action didn't land
 * server-side — the user retries in-app).
 */
@Injectable({ providedIn: 'root' })
export class NotificationActionHttp {
  private readonly http = inject(HttpClient);

  async report(report: NotifActionReport): Promise<void> {
    try {
      await firstValueFrom(
        this.http.post<StandardResponse<null>>(`${apiPrefix()}/notifications/action`, report),
      );
    } catch {
      /* best-effort — a transient failure just means the action didn't land */
    }
  }
}
