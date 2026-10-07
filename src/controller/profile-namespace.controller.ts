import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  ProfileNamespaceService,
  type ProfileNamespacePair,
} from '../federation/profile-namespace.service.js';
import { ProfileNamespaceRefreshService } from '../federation/profile-namespace-refresh.service.js';

interface ProfileNamespaceResolveDto {
  publisherNamespaceId?: unknown;
  profileNamespaceId?: unknown;
}

/** Client-side namespace-bindings resolution. Single-pair POST: the client
 *  demands one (publisher, nsid) pair at a time, mirroring profile
 *  resolution. The server answers READY (with the binding, possibly expired)
 *  or PENDING (a tomb was planted; the client waits for a wake with a 30s
 *  re-request timeout). */
@Controller('profile-namespaces')
export class ProfileNamespaceController {
  constructor(
    private readonly namespaceInfo: ProfileNamespaceService,
    private readonly refresh: ProfileNamespaceRefreshService,
  ) {}

  @Post('resolve')
  @HttpCode(HttpStatus.OK)
  @ApiBody({
    schema: {
      type: 'object',
      required: ['publisherNamespaceId', 'profileNamespaceId'],
      properties: {
        publisherNamespaceId: { type: 'integer', minimum: 0 },
        profileNamespaceId: { type: 'integer', minimum: 0 },
      },
      additionalProperties: false,
    },
  })
  @ApiOkResponse({
    description:
      'READY carries the binding (possibly an expired placeholder); PENDING means no local row exists — a tomb was planted and a background refresh was scheduled.',
  })
  async resolve(@Body() dto: unknown) {
    const pair = dto as {
      publisherNamespaceId?: unknown;
      profileNamespaceId?: unknown;
    };
    if (
      !pair ||
      typeof pair !== 'object' ||
      Array.isArray(pair) ||
      typeof pair.publisherNamespaceId !== 'number' ||
      typeof pair.profileNamespaceId !== 'number' ||
      Object.keys(pair).length !== 2
    )
      throw new BusinessException(
        BusinessCode.VALIDATION_FAILED,
        'body must be a single namespace pair',
        HttpStatus.BAD_REQUEST,
      );
    const result = await this.namespaceInfo.resolveOne({
      publisherNamespaceId: pair.publisherNamespaceId,
      profileNamespaceId: pair.profileNamespaceId,
    });
    if (result.status === 'PENDING')
      this.refresh.scheduleRefresh(
        {
          publisherNamespaceId: pair.publisherNamespaceId,
          profileNamespaceId: pair.profileNamespaceId,
        },
        0n,
      );
    return result;
  }
}
