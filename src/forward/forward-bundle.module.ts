import { Module } from '@nestjs/common';
import { ForwardBundleService } from './forward-bundle.service.js';
import { MessageModule } from '../message/message.module.js';

@Module({
  imports: [MessageModule],
  providers: [ForwardBundleService],
  exports: [ForwardBundleService],
})
export class ForwardBundleModule {}
