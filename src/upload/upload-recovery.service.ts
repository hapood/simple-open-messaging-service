import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { uploadSession } from '../database/schema.js';
import { ResumableUploadService } from './resumable-upload.service.js';

/** Rebuild server-owned continuations from durable sessions, never from client retries. */
@Injectable()
export class UploadRecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(UploadRecoveryService.name);
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly uploads: ResumableUploadService,
  ) {}

  onApplicationBootstrap(): void {
    void this.resume();
  }

  @Interval(30_000)
  async resume(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = await this.database.db
        .select({
          uploadId: uploadSession.uploadId,
          creatorId: uploadSession.creatorId,
        })
        .from(uploadSession)
        .where(eq(uploadSession.status, 'COMPLETING'));
      for (const session of sessions) {
        try {
          // complete() takes the existing cross-process upload/batch locks and re-reads state.
          await this.uploads.complete(session.creatorId, session.uploadId);
        } catch (error) {
          this.logger.warn(
            `Upload continuation ${session.uploadId} failed: ${String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Upload recovery scan failed: ${String(error)}`);
    } finally {
      this.running = false;
    }
  }
}
