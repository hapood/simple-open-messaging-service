import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { MessageThreadType } from '../prisma/generated/client';

/**
 * user 域请求 DTO。验证规则从原内联校验搬来。
 * 注意：IsNumber + Type(() => Number) 配合全局 ValidationPipe transform，
 * 把 JSON/字符串入参转为 number（Prisma 需要 number 类型 id）。
 */

export class UserIdDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;
}

export class UserThreadIdDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userThreadId: number;
}

export class UserByUniqNameDto {
  @IsString()
  @IsNotEmpty()
  uniqName: string;
}

export class QueryUsersDto {
  @IsArray()
  @ArrayMaxSize(100, { message: 'must less than 100 userIds per query' })
  @IsInt({ each: true })
  userIds: number[];
}

export class QueryValidThreadDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  take: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  lastId?: number;

  @IsOptional()
  toObjType?: MessageThreadType;
}

export class QueryPendingThreadDto {
  @Type(() => Number)
  @IsInt()
  beforeDate: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  take: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number;
}
