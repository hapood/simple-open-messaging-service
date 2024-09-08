import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User, Prisma, MessageThreadType, UserMessageThreadStatus } from '@prisma/client';
import { AuthService } from 'src/auth/auth.service';

@Injectable()
export class NotifyService implements OnModuleInit {
  constructor(private prisma: PrismaService, private auth: AuthService) { }

  async onModuleInit() {
  }

}