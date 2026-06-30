import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * 认证相关请求 DTO。验证规则从原 controller 内联校验 1:1 搬来，避免行为漂移。
 * nest-cli swagger 插件（classValidationShim）会据 class-validator 装饰器自动生成 OpenAPI schema，
 * 故无需手写 @ApiProperty。
 */

/** 登录入参（仅用于 login 的 @ApiBody 文档；login 走 LocalStrategy，body 不经 @Body DTO） */
export class LoginDto {
  @IsString()
  @IsNotEmpty()
  uniqName: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

/**
 * 注册入参。格式校验（regex）移入此处 → 失败走 ValidationPipe → 400（符合 P0 ValidationPipe 验收）。
 * 业务校验（uniqName 重复）仍在 service，走 200 + code:2。
 */
export class RegisterDto {
  // 1-20 字符，且至少含 3 个字母（原 user.controller.register 的 nameRegex）
  @Matches(/^(?=[\w.-]{1,20}$)(?:[\d_.-]*[a-zA-Z]){3}[\w.-]*$/, {
    message: 'uniqName must be 1-20 chars ([\\w.-]) with at least 3 letters',
  })
  uniqName: string;

  // 6-20 位，允许 [a-zA-Z0-9.@!#$%^&*()]（原 pwdRegex）
  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'password must be 6-20 chars of allowed set',
  })
  password: string;
}

/** refresh token 入参：renew-access / renew-refresh 共用 */
export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

/** logout 入参：refreshToken 必填；accessJti 可选（即时把当前 access 入黑名单）。 */
export class LogoutDto {
  @IsString()
  @IsNotEmpty()
  refreshToken: string;

  @IsString()
  @IsOptional()
  accessJti?: string;
}

/** 改密入参（newPassword 沿用 RegisterDto 的 6-20 位允许字符集规则）。 */
export class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  oldPassword: string;

  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'newPassword must be 6-20 chars of allowed set',
  })
  newPassword: string;
}

/** 吊销单个会话入参。 */
export class RevokeSessionDto {
  @IsString()
  @IsNotEmpty()
  jti: string;

  @IsString()
  @IsOptional()
  accessJti?: string;
}
