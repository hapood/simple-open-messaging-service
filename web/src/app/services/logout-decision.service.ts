import { Injectable, Injector, inject } from '@angular/core';
import type { LogoutDecision, UnconfirmedLogout } from './session/logout-operation';

/** Two explicit actions; dismissal never authorizes credential deletion. */
@Injectable({ providedIn: 'root' })
export class LogoutDecisionService {
  private readonly injector = inject(Injector);

  async decide(outcome: UnconfirmedLogout): Promise<LogoutDecision> {
    const { RouteService, PopupType } = await import('./route.service');
    return new Promise((resolve, reject) => {
      this.injector.get(RouteService).popupDlg(
        PopupType.CONFIRM,
        {
          titleKey: 'auth.logoutDecision.title',
          messageKey: outcome.status === 'timedOut'
            ? 'auth.logoutDecision.timeout' : 'auth.logoutDecision.failed',
          confirmKey: 'auth.logoutDecision.retry',
          cancelKey: 'auth.logoutDecision.localOnly',
        },
        (result) => {
          if (result === true) resolve('retry');
          else if (result === false) resolve('localOnly');
          else reject(new Error('Logout decision interrupted; credentials retained'));
        },
        { disableClose: true },
      );
    });
  }
}
