import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminController } from './admin.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminJwtStrategy } from './admin.jwt.strategy';
import { AdminAuthGuard } from './admin-auth.guard';
import { PrismaService } from '../prisma.service';
import { jwtConstants } from '../auth/constants';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({ secret: jwtConstants.adminSecret }),
  ],
  controllers: [AdminController],
  providers: [AdminAuthService, AdminJwtStrategy, AdminAuthGuard, PrismaService],
  exports: [AdminAuthService],
})
export class AdminModule {}
