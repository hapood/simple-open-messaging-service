import { ProfileResolutionDto } from '../dto/profile-resolution.dto.js';
import {
  ProfileLookup,
  type ProfileClientResolutionDemand,
} from './profile-resolution-demand.js';
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
      type: 'object',
      required: ['namespaceId', 'lookup', 'target'],
      properties: {
        namespaceId: { type: 'integer', minimum: 0 },
        lookup: {
          type: 'string',
          enum: [
            'ACCOUNT_PROFILE',
            'RELATIONSHIP_INTENT_PROFILE',
            'GROUP_MEMBER_PROFILE',
          ],
        },
        target: { type: 'object' },
        peerAccount: { type: 'string' },
        groupAccount: { type: 'string' },
      },
      additionalProperties: false,
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
                'namespaceId',
                'account',
                'domain',
                'rev',
                'name',
                'bio',
                'avatarBase64',
              ],
              properties: {
                namespaceId: { type: 'integer', minimum: 0 },
                account: { type: 'string' },
                domain: { type: 'string' },
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
              required: ['namespaceId', 'account', 'domain', 'rev'],
              properties: {
                namespaceId: { type: 'integer', minimum: 0 },
                account: { type: 'string' },
                domain: { type: 'string' },
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
  start(@Req() req: FastifyRequest, @Body() body: ProfileResolutionDto) {
    const sessionId = req.user.sessionId;
    if (sessionId === undefined || sessionId === null)
      throw new Error('authenticated profile resolution requires a session');
    return this.coordinator.start(
      req.user.userId,
      sessionId,
      toProfileClientResolutionDemand(body),
    );
  }
}

function toProfileClientResolutionDemand(
  body: ProfileResolutionDto,
): ProfileClientResolutionDemand {
  if (
    (body.namespaceId === 0 && body.target.domain !== 'local') ||
    (body.namespaceId !== 0 && body.target.domain === 'local')
  )
    throw new BadRequestException(
      'profile demand domain must use local for namespace 0 and a remote domain otherwise',
    );

  const target = {
    account: body.target.account,
    domain: body.target.domain,
    rev: body.target.rev,
  };
  switch (body.lookup) {
    case 'ACCOUNT_PROFILE':
      return {
        namespaceId: body.namespaceId,
        lookup: ProfileLookup.ACCOUNT_PROFILE,
        target,
      };
    case 'RELATIONSHIP_INTENT_PROFILE':
      return {
        namespaceId: body.namespaceId,
        lookup: ProfileLookup.RELATIONSHIP_INTENT_PROFILE,
        target,
        peerAccount: body.peerAccount!,
      };
    case 'GROUP_MEMBER_PROFILE':
      return {
        namespaceId: body.namespaceId,
        lookup: ProfileLookup.GROUP_MEMBER_PROFILE,
        target,
        groupAccount: body.groupAccount!,
      };
  }
}
