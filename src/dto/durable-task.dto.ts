import { ApiProperty } from '@nestjs/swagger';

export class DurableTaskAcceptedDto {
  @ApiProperty({ example: '123', description: 'Durable task ID' })
  taskId!: string;

  @ApiProperty({ enum: ['PENDING'] })
  status!: 'PENDING';
}
