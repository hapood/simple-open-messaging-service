import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  OnDestroy,
  signal,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { firstValueFrom } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import { GroupService } from '../../services/group.service';
import { RouteService } from '../../services/route.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { PageHeaderComponent } from '../page-header/page-header.component';

/** Conversation-scoped, plain-text announcement. Acknowledgement is tied to
 * the coordinate captured when this particular dialog opened. */
@Component({
  selector: 'app-group-announcement',
  imports: [PageHeaderComponent, MatButtonModule, TranslocoPipe],
  template: `
    <section class="announcement">
      <app-page-header
        [title]="'group.announcement' | transloco"
        (back)="close()"
      />
      <div class="announcement-text">{{ text() }}</div>
      <footer class="announcement-actions">
        @if (failed()) {
          <button mat-button color="warn" type="button" (click)="acknowledge()">
            {{ 'group.announcementRetry' | transloco }}
          </button>
        }
        <button
          mat-flat-button
          color="primary"
          type="button"
          (click)="confirm()"
        >
          {{ 'common.confirm' | transloco }}
        </button>
      </footer>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        box-sizing: border-box;
      }
      .announcement {
        display: flex;
        flex-direction: column;
        max-height: 100%;
        box-sizing: border-box;
        background: var(--app-surface, white);
        color: var(--app-text);
      }
      .announcement-text {
        min-height: 0;
        white-space: pre-wrap;
        overflow-y: auto;
        overflow-wrap: anywhere;
        font-size: 15px;
        line-height: 24px;
        padding: 16px 20px;
      }
      .announcement-actions {
        box-sizing: border-box;
        min-height: 60px;
        padding: 10px 16px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        border-top: 1px solid var(--app-border-strong);
      }
      .announcement-actions button {
        box-sizing: border-box;
        min-width: 72px;
        height: 40px;
        padding: 0 16px;
        line-height: 20px;
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupAnnouncementComponent implements OnDestroy {
  readonly threadId = input.required<number>();
  readonly feedId = input.required<string>();
  readonly text = input.required<string>();
  readonly failed = signal(false);
  private readonly group = inject(GroupService);
  private readonly route = inject(RouteService);
  private readonly conversations = inject(ConversationListService);
  private pending = false;
  private destroyed = false;
  private frame: number | null = null;

  constructor() {
    afterNextRender(() => {
      if (this.destroyed) return;
      // A read belongs to a popup that actually reached the chatbox surface.
      // The second frame excludes a dialog opened and removed before first paint.
      this.frame = requestAnimationFrame(() => {
        this.frame = requestAnimationFrame(() => {
          this.frame = null;
          if (!this.destroyed) void this.acknowledge();
        });
      });
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
  }

  async acknowledge(): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    this.failed.set(false);
    try {
      const result = await firstValueFrom(
        this.group.markAnnouncementRead(this.threadId(), Number(this.feedId())),
      );
      if (result.code !== 0) throw new Error('announcement read rejected');
      this.conversations.markAnnouncementReadLocally(
        this.threadId(),
        result.data?.announcementReadFeedId ?? Number(this.feedId()),
      );
    } catch {
      this.failed.set(true);
    } finally {
      this.pending = false;
    }
  }

  async confirm(): Promise<void> {
    if (this.failed()) {
      await this.acknowledge();
      if (!this.failed()) {
        this.close();
      }
      return;
    }
    this.close();
  }

  close(): void {
    this.route.closeDlg();
  }
}
