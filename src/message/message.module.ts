import { Module } from '@nestjs/common';
import { MessageService } from './message.service';
import { PrismaService } from '../prisma.service';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [AuthModule],
  providers: [MessageService, PrismaService],
  exports: [MessageService],
})
export class MessageModule { }