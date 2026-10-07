import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class ProfileResolutionTargetDto {
  @ApiProperty({ minimum: 0 })
  @IsDefined()
  @IsInt()
  @Min(0)
  profileNamespaceId!: number;

  @ApiProperty()
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  account!: string;

  @ApiProperty({ minimum: 1 })
  @IsDefined()
  @IsInt()
  @Min(1)
  rev!: number;
}

/** Validated server demand accepted by the profile-resolution endpoint. */
export class ProfileResolutionDto {
  @ApiProperty({ minimum: 0 })
  @IsDefined()
  @IsInt()
  @Min(0)
  publisherNamespaceId!: number;

  @ApiProperty({
    enum: ['ACCOUNT_PROFILE', 'GROUP_MEMBER_PROFILE'],
  })
  @IsDefined()
  @IsIn(['ACCOUNT_PROFILE', 'GROUP_MEMBER_PROFILE'])
  lookup!: 'ACCOUNT_PROFILE' | 'GROUP_MEMBER_PROFILE';

  @ApiProperty({ type: ProfileResolutionTargetDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ProfileResolutionTargetDto)
  target!: ProfileResolutionTargetDto;


  @ApiPropertyOptional()
  @ValidateIf(
    (value: ProfileResolutionDto) => value.lookup === 'GROUP_MEMBER_PROFILE',
  )
  @IsDefined()
  @IsString()
  @IsNotEmpty()
  groupAccount?: string;
}
