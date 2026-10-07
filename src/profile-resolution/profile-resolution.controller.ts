import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import {
  parseProfileDemand,
  ProfileDemandParseError,
  type ProfileDemand,
} from '../../shared/profile-demand.js';
import {
  ProfileLookup,
  type ProfileClientResolutionDemand,
} from './profile-resolution-demand.js';
import { ProfileResolutionCoordinatorService } from './profile-resolution-coordinator.service.js';

@Controller('user/profile-resolution')
export class ProfileResolutionController {
  constructor(
    private readonly coordinator: ProfileResolutionCoordinatorService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiBody({
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['publisherNamespaceId', 'lookup', 'target'],
          properties: {
            publisherNamespaceId: { type: 'integer', minimum: 0 },
            lookup: { type: 'string', enum: ['ACCOUNT_PROFILE'] },
            target: {
              type: 'object',
              required: ['profileNamespaceId', 'account', 'rev'],
              properties: {
                profileNamespaceId: { type: 'integer', minimum: 0 },
                account: { type: 'string' },
                rev: { type: 'integer', minimum: 1 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: [
            'publisherNamespaceId',
            'lookup',
            'target',
            'groupAccount',
          ],
          properties: {
            publisherNamespaceId: { type: 'integer', minimum: 0 },
            lookup: { type: 'string', enum: ['GROUP_MEMBER_PROFILE'] },
            target: {
              type: 'object',
              required: ['profileNamespaceId', 'account', 'rev'],
              properties: {
                profileNamespaceId: { type: 'integer', minimum: 0 },
                account: { type: 'string' },
                rev: { type: 'integer', minimum: 1 },
              },
              additionalProperties: false,
            },
            groupAccount: { type: 'string' },
          },
          additionalProperties: false,
        },
      ],
    },
  })
  @ApiOkResponse({
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['status', 'profile'],
          properties: {
            status: { type: 'string', enum: ['READY'] },
            profile: {
              type: 'object',
              required: [
                'publisherNamespaceId',
                'profileNamespaceId',
                'account',
                'rev',
                'name',
                'bio',
                'avatarBase64',
              ],
              properties: {
                publisherNamespaceId: { type: 'integer', minimum: 0 },
                profileNamespaceId: { type: 'integer', minimum: 0 },
                account: { type: 'string' },
                rev: { type: 'integer', minimum: 1 },
                name: { type: 'string' },
                bio: { type: 'string' },
                avatarBase64: { type: 'string', nullable: true },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['status', 'key'],
          properties: {
            status: { type: 'string', enum: ['PENDING'] },
            key: {
              type: 'object',
              required: [
                'publisherNamespaceId',
                'profileNamespaceId',
                'account',
                'rev',
              ],
              properties: {
                publisherNamespaceId: { type: 'integer', minimum: 0 },
                profileNamespaceId: { type: 'integer', minimum: 0 },
                account: { type: 'string' },
                rev: { type: 'integer', minimum: 1 },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
      ],
    },
  })
  start(@Req() req: FastifyRequest, @Body() body: unknown) {
    const sessionId = req.user.sessionId;
    if (sessionId === undefined || sessionId === null)
      throw new Error('authenticated profile resolution requires a session');
    try {
      return this.coordinator.start(
        req.user.userId,
        sessionId,
        toProfileClientResolutionDemand(parseProfileDemand(body)),
      );
    } catch (error) {
      if (error instanceof ProfileDemandParseError)
        throw new BadRequestException(error.message);
      throw error;
    }
  }
}

function toProfileClientResolutionDemand(
  demand: ProfileDemand,
): ProfileClientResolutionDemand {
  switch (demand.lookup) {
    case 'ACCOUNT_PROFILE':
      return {
        publisherNamespaceId: demand.publisherNamespaceId,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target: demand.target,
      };
    case 'GROUP_MEMBER_PROFILE':
      return {
        publisherNamespaceId: demand.publisherNamespaceId,
        lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
        target: demand.target,
        groupAccount: demand.groupAccount,
      };
  }
}
