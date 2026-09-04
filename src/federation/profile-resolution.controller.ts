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
      oneOf: [
        {
          type: 'object',
          required: ['account', 'domain', 'rev'],
          properties: {
            account: { type: 'string' },
            domain: { type: 'string' },
            rev: { type: 'integer', minimum: 0 },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['threadId', 'messageSeq'],
          properties: {
            threadId: { type: 'integer', minimum: 1 },
            messageSeq: { type: 'integer', minimum: 1 },
          },
          additionalProperties: false,
        },
        {
          type: 'object',
          required: ['threadId', 'memberAccount', 'memberDomain'],
          properties: {
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
                'account',
                'domain',
                'rev',
                'name',
                'bio',
                'avatarBase64',
              ],
              properties: {
                account: { type: 'string' },
                domain: { type: 'string' },
                rev: { type: 'integer', minimum: 0 },
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
    body:
      | { account: string; domain: string; rev: number }
      | { threadId: number; messageSeq: number }
      | { threadId: number; memberAccount: string; memberDomain: string },
  ) {
    return this.coordinator.start(req.user.userId, body);
  }
}
