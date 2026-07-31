import { Global, Module } from '@nestjs/common';
import { ForwardBundleService } from './forward-bundle.service.js';

@Global()
@Module({
  providers: [ForwardBundleService],
  exports: [ForwardBundleService],
})
export class ForwardBundleModule {}
