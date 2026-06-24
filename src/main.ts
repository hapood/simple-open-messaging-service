import 'dotenv/config'; // 最先加载 .env，确保 AppModule 导入链中的 requireEnv 与 Prisma 能读到环境变量
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import { parseCorsOrigins } from './common/env';
import { AllExceptionsFilter } from './common/exception.filter';
import { SerializeInterceptor } from './common/serialize.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app));

  app.use(helmet());
  app.enableCors({
    origin: parseCorsOrigins(process.env.CORS_ORIGIN),
    credentials: true,
  });

  // P1a：全局 ValidationPipe。仅对 @Body() 类型为 DTO class 的路由生效；
  // 仍用内联解构类型的 P1b 路由（group/file/thread-info/by-user-id）无 metatype，管道跳过，不受影响。
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // 剥离 DTO 未定义的字段
      forbidNonWhitelisted: true, // 出现未定义字段直接 400
      transform: true, // 把 plain object 转成 DTO 实例，并按 @Type 转换标量
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // P1b：全局响应序列化拦截器。BigInt→string / Date→毫秒数，
  // 替代原 main.ts 的 Date.prototype.toJSON hack 与 convertBigIntId（均移除）。
  // 异常过滤器不经拦截器链，但其响应体只含 {code,message} 原语，无需转换。
  app.useGlobalInterceptors(new SerializeInterceptor());

  // P1b：全局路由前缀。所有 HTTP 端点统一挂 /api/v1 下（须在 Swagger createDocument 前调用，
  // 文档内端点路径会自动带上此前缀）。Swagger UI 仍挂 /api/v1/docs —— SwaggerModule.setup
  // 不受 setGlobalPrefix 影响，不会双重前缀。WS（WsAdapter）与 CORS 不受影响。
  app.setGlobalPrefix('api/v1');

  // P1a：Swagger。文档 UI 挂 /api/v1/docs。
  const config = new DocumentBuilder()
    .setTitle('Simple Open Chat API')
    .setDescription('面向第三方接入的 IM 开放接口（P1a 契约层）')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/v1/docs', app, document);

  await app.listen(3000);
}
bootstrap();
