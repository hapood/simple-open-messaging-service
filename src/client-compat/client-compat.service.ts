import { Injectable } from '@nestjs/common';
import { CLIENT_API_VERSION } from '../common/client-api-version.js';
import { SERVER_VERSION } from '../common/version.js';
import { deriveOrigin } from '../common/origin.js';
import { PUBLIC_CONFIG } from '../config/public-config.js';
import { ClientCompatDto } from './client-compat.dto.js';
import { SettingsService } from '../settings/settings.service.js';

/** Public client bootstrap data, available before the user has a session. */
@Injectable()
export class ClientCompatService {
  constructor(private readonly settings: SettingsService) {}

  compat(): ClientCompatDto {
    const identityDomain = process.env.SOMS_DOMAIN?.trim();
    const primaryDomain = process.env.SOMS_WEB_DOMAIN?.trim() || identityDomain;
    const lanDomain = process.env.SOMS_LAN_DOMAIN?.trim();
    const fb = this.settings.getFirebaseConfig();
    return {
      apiVersion: CLIENT_API_VERSION,
      serverVersion: SERVER_VERSION,
      ...PUBLIC_CONFIG,
      ...(primaryDomain ? { primaryOrigin: deriveOrigin(primaryDomain) } : {}),
      ...(lanDomain ? { lanOrigin: deriveOrigin(lanDomain) } : {}),
      firebaseConfig: fb
        ? {
            configured: true,
            apiKey: fb.apiKey,
            projectId: fb.projectId,
            appId: fb.appId,
            gcmSenderId: fb.gcmSenderId,
          }
        : { configured: false },
    };
  }
}
