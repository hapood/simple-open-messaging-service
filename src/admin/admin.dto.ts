import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Matches } from 'class-validator';
import { Type } from 'class-transformer';

/** Admin login input. */
export class AdminLoginDto {
  @ApiProperty({ example: 'admin', description: 'Admin username' })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({ example: 'P@ssw0rd', description: 'Password' })
  @IsString()
  @IsNotEmpty()
  password: string;
}

/** Admin refresh input (shared by renew-access / logout). */
export class AdminRefreshDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIs...', description: 'refresh token' })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

/** User list input (pagination + search). */
export class AdminListUsersDto {
  @ApiProperty({ required: false, example: 0, description: 'Number of records to skip (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @ApiProperty({ required: false, example: 20, description: 'Number of records to take (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @ApiProperty({ required: false, example: 'alice', description: 'Fuzzy search by uniqName/display name (optional)' })
  @IsOptional()
  @IsString()
  search?: string;
}

/** Reset-user-password input (reuses the user-side 6-20 char rule). */
export class AdminResetPasswordDto {
  @ApiProperty({
    example: 'NewP@ss2',
    description: 'New password: 6-20 chars, allowed set [a-zA-Z0-9.@!#$%^&*()]',
  })
  @Matches(/^([a-zA-Z0-9\.\@\!\#\$\%\^\&\*\(\)]){6,20}$/, {
    message: 'newPassword must be 6-20 chars of allowed set',
  })
  newPassword: string;
}

/** Unban input (IP and/or account; at least one must be provided). */
export class AdminUnbanDto {
  @ApiProperty({ required: false, example: '1.2.3.4', description: 'Banned IP (optional)' })
  @IsString()
  @IsOptional()
  ip?: string;

  @ApiProperty({ required: false, example: 'alice', description: 'Banned account uniqName (optional)' })
  @IsString()
  @IsOptional()
  uniqName?: string;
}

/** System-wide active session list input (pagination + filter by userId/ip). */
export class AdminListSessionsDto {
  @ApiProperty({ required: false, example: 0, description: 'Number of records to skip (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @ApiProperty({ required: false, example: 20, description: 'Number of records to take (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @ApiProperty({ required: false, example: 1, description: 'Filter by user id (optional)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  userId?: number;

  @ApiProperty({ required: false, example: '1.2.3.4', description: 'Filter by IP (optional)' })
  @IsOptional()
  @IsString()
  ip?: string;
}
