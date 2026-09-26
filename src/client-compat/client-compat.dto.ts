import { ApiProperty } from '@nestjs/swagger';
import { LoginMode } from '../config/public-config.js';

export class ClientFirebaseConfigDto {
  @ApiProperty()
  configured!: boolean;
  @ApiProperty({ required: false })
  apiKey?: string;
  @ApiProperty({ required: false })
  projectId?: string;
  @ApiProperty({ required: false })
  appId?: string;
  @ApiProperty({ required: false })
  gcmSenderId?: string;
}

/** Pre-login configuration. Server version is diagnostic, not an API compatibility gate. */
export class ClientCompatDto {
  @ApiProperty({ example: 1, description: 'Client HTTP API contract version.' })
  apiVersion!: number;
  @ApiProperty({ description: 'Server software version, for diagnostics only.' })
  serverVersion!: string;
  @ApiProperty()
  registrationOpen!: boolean;
  @ApiProperty({ enum: LoginMode, enumName: 'LoginMode' })
  loginMode!: LoginMode;
  @ApiProperty({ required: false })
  primaryOrigin?: string;
  @ApiProperty({ required: false })
  lanOrigin?: string;
  @ApiProperty({ type: ClientFirebaseConfigDto })
  firebaseConfig!: ClientFirebaseConfigDto;
}
