import { IsNotEmpty, IsNumber, IsOptional, IsString, Matches } from 'class-validator';
import { Type } from 'class-transformer';

/** admin 登录入参。 */
export class AdminLoginDto {
  @IsString()
  @IsNotEmpty()
  username: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

/** admin refresh 入参（renew-access / logout 共用）。 */
export class AdminRefreshDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

/** 用户列表入参（分页 + 搜索）。 */
export class AdminListUsersDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @IsOptional()
  @IsString()
  search?: string;
}

/** 重置用户密码入参（沿用用户侧 6-20 位规则）。 */
export class AdminResetPasswordDto {
  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'newPassword must be 6-20 chars of allowed set',
  })
  newPassword: string;
}

/** 解封入参（IP 和/或账户，至少传一个）。 */
export class AdminUnbanDto {
  @IsString()
  @IsOptional()
  ip?: string;

  @IsString()
  @IsOptional()
  uniqName?: string;
}

/** 全系统活跃会话列表入参（分页 + 按 userId/ip 筛选）。 */
export class AdminListSessionsDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  userId?: number;

  @IsOptional()
  @IsString()
  ip?: string;
}
