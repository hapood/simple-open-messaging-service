import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class SaveLinkCardRuleDto {
  @ApiProperty({ example: 'example.com' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @Matches(
    /^(?=.{1,255}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  )
  hostname!: string;

  @ApiProperty({ example: 'Douyin', required: false })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  note?: string;

  @ApiProperty({ enum: ['first', 'last'], default: 'first' })
  @IsIn(['first', 'last'])
  imageSelection: 'first' | 'last' = 'first';

  @ApiProperty({ enum: ['first', 'last'], default: 'first' })
  @IsIn(['first', 'last'])
  descriptionSelection: 'first' | 'last' = 'first';
}
