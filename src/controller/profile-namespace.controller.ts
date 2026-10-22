import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse } from '@nestjs/swagger';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ProfileNamespaceResolutionService } from '../federation/profile-namespace-resolution.service.js';

/** Resolve one client-demanded publisher-scoped namespace binding.
 * PENDING means fetch work was created or joined, not that a cache row exists. */
@Controller('profile-namespaces')
export class ProfileNamespaceController {
  constructor(private readonly resolution: ProfileNamespaceResolutionService) {}

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
      'READY carries a usable binding or an authoritative local answer; PENDING means in-memory fetch work was created or joined.',
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
    return this.resolution.resolveOne({
      publisherNamespaceId: pair.publisherNamespaceId,
      profileNamespaceId: pair.profileNamespaceId,
    });
  }
}
