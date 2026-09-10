import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Client } from 'pg';
import { DatabaseService } from '../database/database.service.js';
import { DurableTaskSchedulerService } from './durable-task-scheduler.service.js';

const CHANNEL = 'durable_task_work';
const RECONNECT_DELAY_MS = 1000;

/** Keeps an idle LISTEN session; task discovery runs only on committed changes
 * or after reconnecting to cover notifications lost while disconnected. */
@Injectable()
export class DurableTaskWakeService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(DurableTaskWakeService.name);
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly scheduler: DurableTaskSchedulerService,
  ) {}

  onApplicationBootstrap(): Promise<void> {
    return this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => undefined);
    await this.connecting;
  }

  private connect(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.listen().finally(() => {
      this.connecting = null;
      if (!this.client) this.scheduleReconnect();
    });
    return this.connecting;
  }

  private async listen(): Promise<void> {
    // A dedicated connection avoids occupying a pooled transaction slot and
    // keeps LISTEN outside transactions for prompt notification delivery.
    const client = new Client({
      ...this.database.pool.options,
      password: this.database.pool.options.password,
      connectionTimeoutMillis: 5000,
      application_name: 'durable-task-listener',
    });
    this.client = client;
    const disconnected = () => {
      if (this.client !== client) return;
      this.client = null;
      void client.end().catch(() => undefined);
      this.scheduleReconnect();
    };
    client.on('error', disconnected);
    client.on('end', disconnected);
    client.on('notification', ({ channel }) => {
      if (!this.stopping && this.client === client && channel === CHANNEL) {
        void this.scheduler.wake();
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      // Subscribe before inspecting work, both initially and after disconnects.
      if (!this.stopping && this.client === client) await this.scheduler.wake();
    } catch (error) {
      if (!this.stopping) {
        this.logger.warn({
          msg: 'durable task listener connection failed',
          err: error,
        });
      }
      disconnected();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.connecting || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }
}
