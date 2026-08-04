import {
  Controller,
  Post,
  Body,
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
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ThrottleGuard, Throttle } from '../auth/throttle.guard.js';
import { ApiResultResponse } from '../common/api-result.js';
import type { LinkContent } from '../upload/file-content.js';
import { LinkPreviewService } from './link-preview.service.js';

/** Request body for POST /link-preview: a single URL the composer wants rendered as a card. */
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
}

/** Swagger model for a resolved link card (the runtime payload is the LinkContent shape). */
class LinkCardDto {
  @ApiProperty() url!: string;
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ required: false }) image?: string;
  @ApiProperty({ required: false }) favicon?: string;
}

/**
 * Composer live-preview endpoint. Resolves a URL into a link card (server-authoritative OG fetch +
 * og:image localization) so the sender sees the card before sending. The same LinkPreviewService is
 * reused by the LINK send path, so the cache built here makes the subsequent send instant.
 *
 * Heavily rate-limited: every call is an outbound fetch, so this is an amplification surface. A page
 * fetch failure rejects generation; missing optional metadata or artwork still produces a valid card.
 */
@ApiTags('link-preview')
@Controller()
export class LinkPreviewController {
  constructor(private readonly linkPreview: LinkPreviewService) {}

  @UseGuards(ThrottleGuard)
  @Throttle(20, 60) // 20 previews/min/user — outbound-fetch amplification ceiling
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @Post('link-preview')
  @ApiOperation({
    summary: 'Resolve a URL into a link card (OpenGraph preview)',
  })
  @ApiResultResponse(LinkCardDto)
  async preview(@Body() dto: LinkPreviewDto): Promise<LinkContent> {
    return this.linkPreview.buildCardContent(dto.url, dto.text ?? '');
  }
}
