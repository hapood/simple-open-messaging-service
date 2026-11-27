import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe } from '@jsverse/transloco';
import type { DatabaseInitFailureKind } from '../../services/session/database-init-failure';

@Component({
  selector: 'app-database-init-dialog',
  imports: [MatDialogModule, MatButtonModule, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ 'auth.databaseInit.title' | transloco }}</h2>
    <mat-dialog-content>
      <p class="kind">{{ kindKey() | transloco }}</p>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button type="button" [mat-dialog-close]="'exit'">
        {{ 'auth.databaseInit.exit' | transloco }}
      </button>
      <button mat-flat-button type="button" color="primary" [mat-dialog-close]="'rebuild'">
        {{ 'auth.databaseInit.rebuild' | transloco }}
      </button>
    </mat-dialog-actions>
  `,
  styles: `
    :host {
      display: block;
    }
    .kind {
      margin: 0;
      line-height: 22px;
    }
  `,
})
export class DatabaseInitDialogComponent {
  private readonly data = inject<DatabaseInitFailureKind>(MAT_DIALOG_DATA);

  protected kindKey(): string {
    return `auth.databaseInit.${this.data}`;
  }
}
