import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  Request,
  UseGuards,
  HttpStatus,
  HttpCode,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import type { FastifyRequest } from 'fastify';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResultResponse } from '../common/api-result.js';
import { LinkPreviewService } from './link-preview.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

/** Request body for starting or retrying an in-memory link-card generation. */
class LinkPreviewDto {
  @ApiProperty({
    example: 'https://github.com/nestjs/nest',
    description: 'The page URL to preview',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  url!: string;

  @ApiProperty({
    required: false,
    description: 'Original text used only as a description fallback',
  })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  text?: string;

  @ApiProperty({
    required: false,
    description:
      'Existing owned generation offered to the server for reuse during a user-triggered retry',
  })
  @IsOptional()
  @IsUUID()
  generationId?: string;
}

class LinkCardGenerationStartDto {
  @ApiProperty() generationId!: string;
  @ApiProperty({ enum: ['pending', 'succeeded', 'failed'] })
  status!: 'pending' | 'succeeded' | 'failed';
  @ApiProperty() expiresAt!: number;
}

/**
 * Starts and polls short-lived in-memory link-card generations. Starting returns immediately; the
 * client renders a resource-free skeleton until polling reports success or failure.
 *
 * Heavily rate-limited: every call is an outbound fetch, so this is an amplification surface. A page
 * fetch failure produces a metadata-free default card; missing optional metadata or artwork also produces
 * a valid card.
 */
@ApiTags('link-preview')
@Controller()
export class LinkPreviewController {
  constructor(private readonly linkPreview: LinkPreviewService) {}

  @UseGuards(ThrottleGuard)
  @Throttle('link-preview.generate')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('link-preview/generations')
  @ApiOperation({
    summary: 'Resolve a URL into a link card (OpenGraph preview)',
  })
  @ApiResultResponse(LinkCardGenerationStartDto)
  preview(@Request() req: FastifyRequest, @Body() dto: LinkPreviewDto) {
    return this.linkPreview.startGeneration(
      req.user.userId,
      dto.url,
      dto.text ?? '',
      dto.generationId,
    );
  }

  @ApiBearerAuth()
  @Get('link-preview/generations/:generationId')
  @ApiOperation({ summary: 'Read an in-memory link-card generation result' })
  generation(
    @Request() req: FastifyRequest,
    @Param('generationId') generationId: string,
  ) {
    const generation = this.linkPreview.getGeneration(
      req.user.userId,
      generationId,
    );
    if (!generation) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'generation not found',
      );
    }
    return generation;
  }
}
