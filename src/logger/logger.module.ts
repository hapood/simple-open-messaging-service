import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { LogStreamStore, logStreamStore } from './log-stream-store.js';
import { buildLoggerParams } from './logger-config.factory.js';
import { LogViewerService } from './log-viewer.service.js';

/**
 * Owns structured logging for the whole app. The pino multistream instance is built in
 * buildLoggerParams() and handed to nestjs-pino via forRootAsync (which registers the global `Logger`
 * provider that app.useLogger(app.get(Logger)) swaps in for Nest's default — so existing
 * `new Logger('Ctx')` call sites route through pino with their context preserved, unchanged).
 *
 * The LogStreamStore is registered with `useValue: logStreamStore` so LogViewerService injects the SAME
 * singleton the pino factory writes to (DI can't construct a second one — the factory already bound the
 * module-level instance into the pino multistream). Imported early in AppModule so it's ready before
 * anything logs.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      // Runs during Nest's async init (after dotenv/config has loaded in main.ts), so LOG_LEVEL and
      // the LOG_* knobs are visible. No injected deps — the store is imported directly.
      useFactory: () => buildLoggerParams(),
    }),
  ],
  // The admin controller (LogViewerController) lives in AdminModule's controllers array — AdminModule
  // imports this module to consume LogViewerService (mirrors AdminDiagnosticsController / DiagnosticsModule).
  providers: [
    LogViewerService,
    { provide: LogStreamStore, useValue: logStreamStore },
  ],
  exports: [LogStreamStore, LogViewerService],
})
export class LoggerModule {}
