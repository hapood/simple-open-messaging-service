import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ServerResponse } from 'http';
import { MessageController } from './controller/message.controller.js';
import { AuthController } from './controller/auth.controller.js';
import { UserModule } from './user/user.module.js';
import { MessageModule } from './message/message.module.js';
import { AuthModule } from './auth/auth.module.js';
import { GatewayModule } from './gateway/gateway.module.js';
import { UserController } from './controller/user.controller.js';
import { GroupModule } from './group/group.module.js';
import { GroupController } from './controller/group.controller.js';
import { UploadModule } from './upload/upload.module.js';
import { RedisModule } from './redis/redis.module.js';
import { AdminModule } from './admin/admin.module.js';
import { NotifyModule } from './notify/notify.module.js';
import { NotifyController } from './controller/notify.controller.js';

// Same-origin, single-image deploy: the built frontends are served from public/.
// In dev the frontends run on their own dev servers (ng serve / vite), so public/ is absent and these are skipped.

// Cache hashed assets for a year; never cache index.html so new deploys are picked up immediately.
const serveStaticOptions = {
  maxAge: '1y',
  setHeaders: (res: ServerResponse, resourcePath: string) => {
    if (resourcePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
};

// path-to-regexp v8 wildcard segment (used by @nestjs/serve-static's exclude).
const API = '/api/{*any}';
const UPLOADS = '/uploads/{*any}';
const ADMIN = '/admin/{*any}';

const staticImports = existsSync(join(process.cwd(), 'public', 'web'))
  ? [
      ServeStaticModule.forRoot(
        // Admin SPA under /admin (deep links like /admin/users fall back to its index.html).
        // renderPath stays default (string) — validatePath only handles strings, not RegExp;
        // isolation between SPAs/api is done via exclude with {*any} wildcard segments.
        {
          rootPath: join(process.cwd(), 'public', 'admin'),
          serveRoot: '/admin',
          exclude: [API, UPLOADS],
          serveStaticOptions,
        },
        // Web SPA at root (no serveRoot, avoids the '/' + '/{*any}' double-slash).
        // Exclude api/uploads/admin so those keep reaching NestJS instead of the SPA fallback.
        {
          rootPath: join(process.cwd(), 'public', 'web'),
          exclude: [API, UPLOADS, ADMIN],
          serveStaticOptions,
        },
      ),
    ]
  : [];

@Module({
  imports: [
    EventEmitterModule.forRoot(),
    ...staticImports,
    RedisModule,
    AuthModule,
    UserModule,
    GatewayModule,
    MessageModule,
    GroupModule,
    UploadModule,
    AdminModule,
    NotifyModule,
  ],
  controllers: [
    MessageController,
    AuthController,
    UserController,
    GroupController,
    NotifyController,
  ],
  providers: [],
})
export class AppModule {}
