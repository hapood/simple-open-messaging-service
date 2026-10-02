import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  ProfileNamespaceInfoService,
  type ProfileNamespacePair,
} from '../federation/profile-namespace-info.service.js';
import { ProfileNamespaceRefreshService } from '../federation/profile-namespace-refresh.service.js';

interface ProfileNamespaceResolveDto {
  pairs?: unknown;
}

/** Client-side namespace-bindings resolution. Batched POST: message lists
 *  demand many (publisher, nsid) pairs at once, and the server needs the
 *  publisher id to know whose namespace space each nsid lives in. */
@Controller('profile-namespaces')
export class ProfileNamespaceController {
  constructor(
    private readonly namespaceInfo: ProfileNamespaceInfoService,
    private readonly refresh: ProfileNamespaceRefreshService,
  ) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['pairs'],
      properties: {
        pairs: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            required: ['publisherNamespaceId', 'profileNamespaceId'],
            properties: {
              publisherNamespaceId: { type: 'integer', minimum: 0 },
              profileNamespaceId: { type: 'integer', minimum: 0 },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
  })
  @ApiOkResponse({
    description:
      'Bindings per pair. Direct rows answer synchronously; third-party rows may answer expired placeholders while a background refresh converges.',
  })
  async resolve(@Body() dto: ProfileNamespaceResolveDto) {
    const raw = dto?.pairs;
    if (
      !Array.isArray(raw) ||
      raw.length < 1 ||
      raw.length > 100 ||
      raw.some(
        (pair) =>
          !pair ||
          typeof pair !== 'object' ||
          Array.isArray(pair) ||
          Object.keys(pair).length !== 2 ||
          typeof (pair as ProfileNamespacePair).publisherNamespaceId !==
            'number' ||
          typeof (pair as ProfileNamespacePair).profileNamespaceId !== 'number',
      )
    ) {
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'pairs must be 1 to 100 closed namespace pairs',
        HttpStatus.BAD_REQUEST,
      );
    }
    const { entries, pendingRefreshes } = await this.namespaceInfo.resolveBatch(
      raw as ProfileNamespacePair[],
    );
    for (const pending of pendingRefreshes)
      this.refresh.scheduleRefresh(pending.pair, pending.triggerFeedId);
    return { entries };
  }
}
