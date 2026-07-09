import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * The app's SINGLE PrismaClient / pg.Pool, made global so every module injects the same instance.
 * PrismaService used to be declared in each feature module's own `providers` array; under NestJS'
 * module-scoped DI that minted a separate PrismaClient (each with its own node-pg Pool, default
 * max=10 connections) per module — 13 pools, i.e. up to 130 concurrent DB connections from ONE Node
 * process, against PostgreSQL's default max_connections=100. Centralizing here collapses that to one
 * shared pool. The driver-adapter path in PrismaService means the pool is node-pg's and is sized by
 * the PrismaPg options there (not a `?connection_limit=` URL param).
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
