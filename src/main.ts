import 'dotenv/config'; // 最先加载 .env，确保 AppModule 导入链中的 requireEnv 与 Prisma 能读到环境变量
import { NestFactory } from '@nestjs/core';
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
  app.useGlobalFilters(new AllExceptionsFilter());

  await app.listen(3000);
}
bootstrap();
