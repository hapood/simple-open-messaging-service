import { ApiProperty } from '@nestjs/swagger';

export class DomainCommandAcceptedDto {
  @ApiProperty({ example: '123', description: 'Durable command ID' })
  commandId!: string;

  @ApiProperty({ enum: ['PENDING'] })
  status!: 'PENDING';
}
