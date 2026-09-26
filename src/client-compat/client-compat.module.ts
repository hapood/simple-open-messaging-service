import { Module } from '@nestjs/common';
import { ClientCompatService } from './client-compat.service.js';

@Module({ providers: [ClientCompatService], exports: [ClientCompatService] })
export class ClientCompatModule {}
