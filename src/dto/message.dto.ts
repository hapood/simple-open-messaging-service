import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ContentType } from '../prisma/generated/client';

/** 消息域请求 DTO。验证规则从原 message.controller 内联类型搬来。 */

export class SendMessageDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userThreadId: number;

  @IsString()
  @IsNotEmpty()
  content: string;

  @IsOptional()
  @IsIn(['PURE_TEXT', 'INVITE', 'IMAGE', 'VIDEO', 'FILE', 'AUDIO'])
  contentType?: ContentType;
}

export class QueryMessagesDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userThreadId: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  take: number;

  @IsOptional()
  @IsString()
  lastId?: string;

  @IsIn(['desc', 'asc'])
  orderBy: 'desc' | 'asc';
}
