import {
  Observable,
  Subscription,
  catchError,
  defer,
  firstValueFrom,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import { syncServerOrigins, tauriInvoke } from './runtime';
import type { FirebaseClientConfigPayload } from './push.service';

export interface ServerSetupProbe {
  primaryOrigin?: string | null;
  lanOrigin?: string | null;
  firebaseConfig?: FirebaseClientConfigPayload | null;
}

export interface ServerSetupResult {
  origins: { primary: string; secondary: string | null };
  active: string;
}

/** Admission for one signed-out setup operation. */
export function beginServerSetup(): Observable<string> {
  return defer(() => tauriInvoke<string>('begin_server_setup'));
}

/** Cancellable verification (compat + certificate) against one origin. */
export function checkServerSetup(
  id: string,
  origin: string,
): Observable<ServerSetupProbe> {
  return defer(() =>
    tauriInvoke<ServerSetupProbe>('check_server_setup', { id, origin }),
  );
}

/**
 * The commit point. Once Rust admits it, the save runs to success or failure and
 * is never cancelled by this side; dismissal must wait for the returned result.
 */
export function commitServerSetup(
  id: string,
  useAdvertised: boolean,
): Observable<ServerSetupResult> {
  return defer(() =>
    tauriInvoke<ServerSetupResult>('commit_server_setup', {
      id,
      useAdvertised,
    }),
  ).pipe(
    tap((result) =>
      syncServerOrigins(
        result.origins.primary,
        result.origins.secondary,
        result.active,
      ),
    ),
  );
}

/** Own verification and confirmation as one cancellable resource. A late admission is
 * cancelled even if its observer disappeared before Rust returned the operation ID.
 * Emitting the decision transfers ownership to the non-cancellable commit stage. */
export function prepareServerSetup(
  origin: string,
  decide: (probe: ServerSetupProbe) => Observable<boolean>,
): Observable<{ id: string; probe: ServerSetupProbe; useAdvertised: boolean }> {
  return new Observable((subscriber) => {
    const work = new Subscription();
    let id: string | undefined;
    let transferred = false;
    const cancel = (id: string) => cancelServerSetup(id).subscribe();
    // Do not unsubscribe admission: its eventual ID is needed to cancel native work.
    void firstValueFrom(beginServerSetup()).then(
      (admitted) => {
        id = admitted;
        if (subscriber.closed) {
          cancel(id);
          return;
        }
        work.add(
          checkServerSetup(id, origin)
            .pipe(
              switchMap((probe) =>
                decide(probe).pipe(
                  map((useAdvertised) => ({
                    id: admitted,
                    probe,
                    useAdvertised,
                  })),
                ),
              ),
            )
            .subscribe({
              next: (result) => {
                transferred = true;
                subscriber.next(result);
                subscriber.complete();
              },
              error: (error: unknown) => subscriber.error(error),
            }),
        );
      },
      (error: unknown) => subscriber.error(error),
    );
    return () => {
      work.unsubscribe();
      if (id !== undefined && !transferred) cancel(id);
    };
  });
}

/** Best-effort cancellation of a verification that never reached commit. */
export function cancelServerSetup(id: string): Observable<void> {
  return defer(() => tauriInvoke<void>('cancel_server_setup', { id })).pipe(
    catchError(() => of(undefined)),
  );
}
