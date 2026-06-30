import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AdminController } from './admin.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminJwtStrategy } from './admin.jwt.strategy';
import { AdminAuthGuard } from './admin-auth.guard';
import { PrismaService } from '../prisma.service';
import { jwtConstants } from '../auth/constants';
import { AuthModule } from '../auth/auth.module';
import { UserManageModule } from '../user-manage/user-manage.module';
import { GatewayModule } from '../gateway/gateway.module';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({ secret: jwtConstants.adminSecret }),
    AuthModule,
    UserManageModule,
    // SseService（导出自 GatewayModule）供 admin/connections 观测在线 SSE 连接。
    GatewayModule,
  ],
  controllers: [AdminController],
  providers: [AdminAuthService, AdminJwtStrategy, AdminAuthGuard, PrismaService],
  exports: [AdminAuthService],
})
export class AdminModule {}
