import { IsNotEmpty, IsString } from 'class-validator';

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
