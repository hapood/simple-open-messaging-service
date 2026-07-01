import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
} from 'class-validator';
import { MessageThreadType } from '../prisma/generated/client.js';

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

/**
 * 更新当前用户资料（昵称/简介）。字段都可选，仅传需更新的。
 * handle（uniqName）不可在此改——身份变更走独立流程。
 */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 30, { message: 'name must be 1-30 chars' })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120, { message: 'bio must be at most 120 chars' })
  bio?: string;
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

  // 前端 queryToPending 只发 { take, beforeDate }，不带 skip（依赖 Prisma skip:undefined=不分页）。
  // 故设可选；提供时仍校验为非负整数。
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}
