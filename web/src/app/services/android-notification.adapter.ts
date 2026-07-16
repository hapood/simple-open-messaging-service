import { NotificationAdapter } from './notification-adapter';

/**
 * Android notification via the Kotlin `SomsNotify` `@JavascriptInterface` (registered in `MainActivity` alongside
 * `SomsFcm` / `SomsShell` / `SomsBack`). That bridge EXPOSES the Android native notification method's parameters
 * to JS — `show(text, replace)` posts on `CHANNEL_MESSAGES` at the stable `AWAY_NOTIF_ID` when `replace` is true
 * (the native replace-by-id), else a fresh id; `clear` cancels it. This adapter is the JS layer that smooths the
 * platform difference: it maps the unified `merge` param onto `replace` (merge=true → replace the prior
 * notification).
 *
 * Per the native-bridge rule, this adapter runs only on Android, so `window.SomsNotify` is guaranteed present —
 * call with `!`, never `?`.
 */
export class AndroidNotificationAdapter extends NotificationAdapter {
  show(text: string, merge: boolean): void {
    window.SomsNotify!.show(text, merge);
  }

  clear(): void {
    window.SomsNotify!.clear();
  }
}
