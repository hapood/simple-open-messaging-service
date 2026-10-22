import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';

export interface SessionDetailsDialogData {
  device: string;
  client: string;
  userAgent: string | null;
  ip: string;
  signedIn: string;
  lastActive: string;
  expires: string;
  isCurrent: boolean;
}

@Component({
  selector: 'app-session-details-dialog',
  imports: [MatDialogModule, MatButtonModule, TranslocoPipe],
  template: `
    <div class="sheet-handle" aria-hidden="true"></div>
    <h2 mat-dialog-title>{{ data.device }}</h2>
    <mat-dialog-content>
      <dl>
        <div>
          <dt>{{ 'session.client' | transloco }}</dt>
          <dd>{{ data.client }}</dd>
        </div>
        @if (data.userAgent) {
          <div>
            <dt>{{ 'session.userAgent' | transloco }}</dt>
            <dd class="break">{{ data.userAgent }}</dd>
          </div>
        }
        <div>
          <dt>{{ 'session.ipLabel' | transloco }}</dt>
          <dd>{{ data.ip }}</dd>
        </div>
        <div>
          <dt>{{ 'session.signedInLabel' | transloco }}</dt>
          <dd>{{ data.signedIn }}</dd>
        </div>
        <div>
          <dt>{{ 'session.lastActiveLabel' | transloco }}</dt>
          <dd>{{ data.lastActive }}</dd>
        </div>
        <div>
          <dt>{{ 'session.expiresLabel' | transloco }}</dt>
          <dd>{{ data.expires }}</dd>
        </div>
      </dl>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close type="button">
        {{ 'common.close' | transloco }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    :host {
      display: block;
    }
    .sheet-handle {
      display: none;
    }
    dl {
      margin: 0;
    }
    dl > div {
      padding: 10px 0;
      border-bottom: 1px solid var(--app-border);
    }
    dl > div:last-child {
      border-bottom: 0;
    }
    dt {
      color: var(--app-text-muted);
      font-size: 12px;
      line-height: 18px;
    }
    dd {
      margin: 2px 0 0;
      color: var(--app-text);
      font-size: 14px;
      line-height: 20px;
    }
    .break {
      overflow-wrap: anywhere;
    }
    @media (max-width: 719px) {
      .sheet-handle {
        display: block;
        width: 32px;
        height: 4px;
        margin: 8px auto 0;
        border-radius: 2px;
        background: var(--app-border);
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionDetailsDialogComponent {
  readonly data = inject<SessionDetailsDialogData>(MAT_DIALOG_DATA);
}
