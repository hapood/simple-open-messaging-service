import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  OnDestroy,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TranslocoPipe } from '@jsverse/transloco';
import { GroupService } from '../../services/group.service';
import { RouteService } from '../../services/route.service';
import { ConversationListService } from '../../services/conversation-list.service';

/** Conversation-scoped, plain-text announcement. Acknowledgement is tied to
 * the coordinate captured when this particular dialog opened. */
@Component({
  selector: 'app-group-announcement',
  imports: [TranslocoPipe],
  template: `
    <section class="announcement" aria-labelledby="announcement-title">
      <header>
        <h2 id="announcement-title">{{ 'group.announcement' | transloco }}</h2>
        <button
          type="button"
          (click)="close()"
          [attr.aria-label]="'common.close' | transloco"
        >
          ×
        </button>
      </header>
      <div class="announcement-text">{{ text() }}</div>
      @if (failed()) {
        <button type="button" (click)="acknowledge()">
          {{ 'group.announcementRetry' | transloco }}
        </button>
      }
    </section>
  `,
  styles: [
    `
      .announcement {
        display: flex;
        flex-direction: column;
        max-height: 100%;
        box-sizing: border-box;
        padding: 16px;
        background: var(--app-surface, white);
        border-radius: 12px;
      }
      header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      h2 {
        font-size: 18px;
        line-height: 24px;
        margin: 0;
      }
      button {
        min-height: 32px;
        line-height: 20px;
        border: 0;
        background: transparent;
        cursor: pointer;
      }
      .announcement-text {
        min-height: 0;
        white-space: pre-wrap;
        overflow: auto;
        overflow-wrap: anywhere;
        line-height: 22px;
        padding: 12px 0;
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

  close(): void {
    this.route.closeDlg();
  }
}
