import 'dotenv/config'; // Load .env first so the AppModule import chain (requireEnv, Prisma) sees the vars.
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import helmet from 'helmet';
// compression ships a CommonJS function export with no `default`, so (per project tsconfig without
// esModuleInterop) it must be imported via `require`, otherwise it compiles but throws at runtime.
import compression = require('compression');
import { AllExceptionsFilter } from './common/exception.filter';
import { SerializeInterceptor } from './common/serialize.interceptor';
import { join } from 'path';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Trust a single reverse-proxy hop so rate limiting sees the real client IP (see local.strategy.ts).
  // Set to the actual hop count in prod; never `true` (X-Forwarded-For is spoofable).
  app.set('trust proxy', 1);

  app.use(helmet());
  // gzip/brotli for static assets + API responses.
  app.use(compression());

  // Uploaded images land in process.cwd()/uploads and are served at /uploads/*.
  // NestExpressAdapter's prefix option mounts the dir under /uploads/, matching UploadService.save's url prefix.
  app.useStaticAssets(join(process.cwd(), 'uploads'), { prefix: '/uploads/' });

  // Same-origin in production (single-image, path-prefix deploy) → no CORS needed.
  // Dev echoes any Origin so the separate frontend dev servers (web :4200, admin :5180) can call :3000.
  const isDev = process.env.NODE_ENV !== 'production';
  app.enableCors({ origin: isDev });

  // Global ValidationPipe. Only applies to @Body() of DTO-class routes; P1b routes with inline destructured
  // types have no metatype and are skipped.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip fields not declared on the DTO
      forbidNonWhitelisted: true, // reject requests with undeclared fields (400)
      transform: true, // convert plain objects to DTO instances and coerce scalars via @Type
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Global response serializer: BigInt→string, Date→ms. Replaces the former toJSON hack / convertBigIntId.
  app.useGlobalInterceptors(new SerializeInterceptor());

  // Global route prefix. All HTTP endpoints (incl. SSE /events) live under /api/v1 (must be set before Swagger
  // createDocument so doc paths include it). Swagger UI mounts at /api/v1/docs (SwaggerModule.setup ignores the prefix).
  app.setGlobalPrefix('api/v1');

  // Swagger UI at /api/v1/docs.
  const config = new DocumentBuilder()
    .setTitle('Simple Open Chat API')
    .setDescription('Third-party IM integration API (P1a contract layer)')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);

  await app.listen(3000);
}
bootstrap();
