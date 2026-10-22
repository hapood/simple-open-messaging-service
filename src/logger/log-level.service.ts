import { Inject, Injectable } from '@nestjs/common';
import { PARAMS_PROVIDER_TOKEN, type Params } from 'nestjs-pino';
import type { Logger } from 'pino';

export const LOG_OUTPUT_LEVELS = [
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;
export type LogOutputLevel = (typeof LOG_OUTPUT_LEVELS)[number];

/** The root logger is the sole owner of the process-local output threshold. */
@Injectable()
export class LogLevelService {
  private readonly logger: Logger;

  constructor(@Inject(PARAMS_PROVIDER_TOKEN) params: Params) {
    const options = params.pinoHttp;
    if (
      !options ||
      Array.isArray(options) ||
      !('logger' in options) ||
      !options.logger
    ) {
      throw new Error('Log level control requires the shared pino logger');
    }
    this.logger = options.logger;
  }

  getLevel(): { level: LogOutputLevel } {
    return { level: this.logger.level as LogOutputLevel };
  }

  setLevel(level: LogOutputLevel): { level: LogOutputLevel } {
    this.logger.level = level;
    return this.getLevel();
  }
}
