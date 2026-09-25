import { inject, Injectable, Injector } from '@angular/core';
import { openExternalUrl } from './runtime';

/** Navigation policy is separate from the wire format: arbitrary URI schemes can be shown in messages. */
export function externalLinkPolicy(url: string): 'open' | 'confirm' | 'block' {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f-\u009f]+$/.test(url))
    return 'block';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'block';
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:')
    return 'open';
  // These schemes execute content or access local resources rather than invoking an external handler.
  if (
    ['javascript:', 'data:', 'blob:', 'file:', 'about:', 'content:'].includes(
      parsed.protocol,
    )
  )
    return 'block';
  return 'confirm';
}

@Injectable({ providedIn: 'root' })
export class ExternalLinkService {
  private readonly injector = inject(Injector);

  async open(url: string): Promise<void> {
    const policy = externalLinkPolicy(url);
    if (policy === 'block') return;
    if (policy === 'open') {
      await openExternalUrl(url);
      return;
    }
    // Defer loading the dialog registry: it imports message components, which use this service.
    const { RouteService, PopupType } = await import('./route.service');
    this.injector.get(RouteService).popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'linkCard.externalSchemeTitle',
        messageKey: 'linkCard.externalSchemePrompt',
        messageParams: { scheme: new URL(url).protocol.slice(0, -1), url },
        confirmKey: 'linkCard.open',
      },
      (result) => {
        if (result === true)
          void openExternalUrl(url).catch((error) =>
            console.error('[external-link] Failed to open URL', error),
          );
      },
    );
  }
}
