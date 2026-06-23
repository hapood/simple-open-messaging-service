import 'dotenv/config'; // 最先加载 .env，确保 AppModule 导入链中的 requireEnv 与 Prisma 能读到环境变量
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { WsAdapter } from '@nestjs/platform-ws';
import helmet from 'helmet';
import { parseCorsOrigins } from './common/env';
import { AllExceptionsFilter } from './common/exception.filter';

// ⚠️ P0 保留：全局覆盖 Date.prototype.toJSON（Date→毫秒戳）。
// P1b 将由「响应序列化拦截器」替代并移除此全局副作用（protocol-plan §4.2.5 / bug #8）。
Date.prototype.toJSON = function () {
  return this.getTime();
};

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

  // P1a：Swagger。文档 UI 挂 /api/v1/docs；路由本身暂不加 /api/v1 全局前缀（前缀属 P1b）。
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
