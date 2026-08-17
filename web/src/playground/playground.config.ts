import {
  ApplicationConfig,
  CSP_NONCE,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideRouter } from '@angular/router';
import { MAT_SNACK_BAR_DEFAULT_OPTIONS } from '@angular/material/snack-bar';
import {
  provideTransloco,
  provideTranslocoTranspiler,
} from '@jsverse/transloco';
import { CspSafeIcuTranspiler } from '../app/i18n/csp-safe-icu.transpiler';
import { InlineTranslocoLoader } from '../app/i18n/transloco.loader';
import { MediaSizeThresholdService } from '../app/services/media-size-threshold.service';
import { MESSAGE_THREAD_ADAPTER } from '../app/components/message-thread/message-thread-adapter';
import { PlaygroundMessageThreadAdapter } from './playground-message-thread.adapter';
import { WebsocketService } from '../app/services/websocket.service';
import { PlaygroundRealtime } from './playground-realtime.mock';
import { LinkCardGenerationService } from '../app/services/link-card-generation.service';
import { PlaygroundLinkGeneration } from './playground-link-generation.mock';

/** Mock media is embedded as data/blob URLs, so this standalone entry never applies the production
 * remote-download size gate. The production app keeps its normal user-configurable service. */
const playgroundMediaThreshold = {
  policy: () => ({ mode: 'unlimited' as const }),
  shouldDefer: () => false,
  isLoaded: () => true,
  markLoaded: () => undefined,
};

function readCspNonce(): string | null {
  if (typeof document === 'undefined') return null;
  const element = document.querySelector('style[nonce], script[nonce]') as
    | ({ nonce: string } & Element)
    | null;
  return element?.nonce || null;
}

/** Presentation-only providers required by the production chat components. Production boot tasks and
 * transports are intentionally absent: the playground owns an in-memory conversation data source. */
export const playgroundConfig: ApplicationConfig = {
  providers: [
    { provide: CSP_NONCE, useValue: readCspNonce() },
    provideZonelessChangeDetection(),
    provideHttpClient(withFetch()),
    provideRouter([]),
    provideAnimationsAsync(),
    {
      provide: MediaSizeThresholdService,
      useValue: playgroundMediaThreshold,
    },
    {
      provide: MESSAGE_THREAD_ADAPTER,
      useExisting: PlaygroundMessageThreadAdapter,
    },
    {
      provide: WebsocketService,
      useExisting: PlaygroundRealtime,
    },
    {
      provide: LinkCardGenerationService,
      useExisting: PlaygroundLinkGeneration,
    },
    provideTransloco({
      config: {
        availableLangs: [
          { id: 'en', label: 'English' },
          { id: 'zh-CN', label: '简体中文' },
        ],
        defaultLang: 'en',
        reRenderOnLangChange: true,
        prodMode: true,
      },
      loader: InlineTranslocoLoader,
    }),
    provideTranslocoTranspiler(CspSafeIcuTranspiler),
    {
      provide: MAT_SNACK_BAR_DEFAULT_OPTIONS,
      useValue: {
        horizontalPosition: 'center',
        verticalPosition: 'bottom',
        panelClass: 'soms-snack-bar',
        duration: 4000,
      },
    },
  ],
};
