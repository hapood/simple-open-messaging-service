import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiBearerAuth, ApiBody, ApiOperation } from '@nestjs/swagger';
import { QuoteResolutionCoordinatorService } from './quote-resolution-coordinator.service.js';

@Controller('message/quote-resolution')
export class QuoteResolutionController {
  constructor(
    private readonly coordinator: QuoteResolutionCoordinatorService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Resolve a visible message quote; pending results arrive on the authenticated events stream',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['threadId', 'messageSeq'],
      additionalProperties: false,
      properties: {
        threadId: { type: 'integer', minimum: 1 },
        messageSeq: { type: 'integer', minimum: 1 },
      },
    },
  })
  start(
    @Req() req: FastifyRequest,
    @Body() body: { threadId: number; messageSeq: number },
  ) {
    return this.coordinator.start(req.user.userId, body);
  }
}
