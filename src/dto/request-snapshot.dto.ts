import { ApiProperty } from '@nestjs/swagger';
import { ValidateBy } from 'class-validator';
import { parseRequestSnapshot } from '../../shared/request-snapshot.js';

/** The complete send-time target presentation; never used for authorization. */
export function IsRequestSnapshot(): PropertyDecorator {
  return ValidateBy({
    name: 'requestSnapshot',
    validator: {
      validate: (value: unknown) => {
        try {
          parseRequestSnapshot(value);
          return true;
        } catch {
          return false;
        }
      },
      defaultMessage: () => 'snapshot must contain displayName and an explicit avatar',
    },
  });
}

export class RequestSnapshotDto {
  @ApiProperty({ description: 'Send-time target display name', maxLength: 31 })
  displayName!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Retained avatar reference, or null' })
  avatar!: string | null;
}
