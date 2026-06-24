import { Type } from 'class-transformer';
import { IsInt, IsString, MaxLength, Min } from 'class-validator';

/**
 * group 域请求 DTO。验证规则：
 * - groupName 原 controller 手动 length>31 校验，迁入 @MaxLength(31)（超长 → 400）；
 *   保留原「允许空名」行为，不加 @IsNotEmpty。
 * - id 类字段 @Type(()=>Number)+@IsInt 配合全局 ValidationPipe transform，
 *   把 JSON/字符串入参转 number（Prisma 需要 number）。
 */

export class CreateGroupDto {
  /** 群名，最长 31 字符（原 controller 校验 length <= 31） */
  @IsString()
  @MaxLength(31, { message: 'group name must less than 32 characters' })
  groupName: string;
}

export class InviteGroupDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  userId: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;
}

export class JoinGroupDto {
  @IsString()
  token: string;
}

export class GroupIdDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  groupId: number;
}
