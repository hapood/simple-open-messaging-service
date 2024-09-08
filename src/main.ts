import { NestFactory, HttpAdapterHost } from '@nestjs/core';
import { AppModule } from './app.module';
import { WsAdapter } from './ws-adapter';

Date.prototype.toJSON = function () {
  return this.getTime()
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useWebSocketAdapter(new WsAdapter(app, app.get(HttpAdapterHost)));
  app.enableCors();
  await app.listen(3000);
}
bootstrap();
