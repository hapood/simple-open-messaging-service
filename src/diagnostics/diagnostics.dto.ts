import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';

/** Admin diagnostic-report list input (pagination + search by reporter name/account). Mirrors
 *  AdminListUsersDto so the admin list page reuses the standard useListParams + Pagination shell. */
export class AdminListDiagnosticsDto {
  @ApiProperty({
    required: false,
    example: 0,
    description: 'Number of records to skip (optional)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  skip?: number;

  @ApiProperty({
    required: false,
    example: 20,
    description: 'Number of records to take (optional)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  take?: number;

  @ApiProperty({
    required: false,
    example: 'alice',
    description: 'Fuzzy search by reporter account/display name (optional)',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
