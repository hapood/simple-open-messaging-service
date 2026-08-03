import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class SaveLinkCardRuleDto {
  @ApiProperty({ example: 'https://www.example.com' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  matchUrl!: string;

  @ApiProperty({ example: 'Example' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @ApiProperty({ default: true })
  @IsBoolean()
  includeSubdomains!: boolean;

  @ApiProperty({ default: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ default: 0, minimum: -10000, maximum: 10000 })
  @Type(() => Number)
  @IsInt()
  @Min(-10000)
  @Max(10000)
  priority!: number;
}
