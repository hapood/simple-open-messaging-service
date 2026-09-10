import type { ProfileSelector } from '../../shared/profile-selector.js';
import {
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
      discriminator: { propertyName: 'type' },
      oneOf: [
        {
          type: 'object',
          required: ['type', 'account', 'domain', 'rev'],
          properties: {
            type: { type: 'string', enum: ['EXACT'] },
            account: { type: 'string' },
            domain: { type: 'string' },
            rev: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['type', 'threadId', 'messageSeq'],
          properties: {
            type: { type: 'string', enum: ['MESSAGE_AUTHOR'] },
            threadId: { type: 'integer', minimum: 1 },
            messageSeq: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['type', 'threadId', 'memberAccount', 'memberDomain'],
          properties: {
            type: { type: 'string', enum: ['GROUP_MEMBER'] },
            threadId: { type: 'integer', minimum: 1 },
            memberAccount: { type: 'string' },
            memberDomain: { type: 'string' },
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
          required: ['status', 'requestId'],
          properties: {
            status: { type: 'string', enum: ['PENDING'] },
            requestId: { type: 'string', format: 'uuid' },
          },
          additionalProperties: false,
        },
      ],
    },
  })
  start(
    @Req() req: FastifyRequest,
    @Body()
    body: ProfileSelector,
  ) {
    return this.coordinator.start(req.user.userId, body);
  }
}
