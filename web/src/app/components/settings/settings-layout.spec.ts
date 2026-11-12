import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatCardModule } from '@angular/material/card';
import { MatListModule } from '@angular/material/list';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelect, MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { By } from '@angular/platform-browser';

@Component({
  imports: [
    MatCardModule,
    MatListModule,
    MatRadioModule,
    MatSelectModule,
    MatButtonModule,
    MatSlideToggleModule,
  ],
  styleUrl: './sub-page.scss',
  template: `
    <section class="settings-group">
      <mat-card class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>System notification permission</span>
            <span matListItemLine>Allow notifications in System Settings</span>
            <button mat-button matListItemMeta>System Settings</button>
          </mat-list-item>
          <mat-list-item>
            <span matListItemTitle>Notification sound</span>
            <span matListItemLine>Play system sound</span>
            <mat-slide-toggle matListItemMeta />
          </mat-list-item>
          <mat-list-item>
            <span matListItemTitle>Notification preview</span>
            <span matListItemLine>Description</span>
            <mat-select matListItemMeta class="settings-select" value="message">
              <mat-option value="message">Show message</mat-option>
            </mat-select>
          </mat-list-item>
          <mat-list-item>
            <span matListItemTitle>Open at latest message</span>
            <span matListItemLine>Description</span>
            <mat-radio-button matListItemMeta />
          </mat-list-item>
        </mat-list>
      </mat-card>
    </section>
    <section class="settings-group">
      <mat-card class="settings-card">Next card</mat-card>
    </section>
  `,
})
class SettingsLayoutFixture {}

describe('settings trailing control layout', () => {
  afterEach(() => TestBed.resetTestingModule());

  for (const width of [320, 450]) {
    it(`keeps the preview panel within a ${width}px settings surface`, async () => {
      const fixture = TestBed.createComponent(SettingsLayoutFixture);
      const host = fixture.nativeElement as HTMLElement;
      host.style.width = `${width}px`;
      fixture.detectChanges();
      await fixture.whenStable();

      const center = (rect: DOMRect) => rect.top + rect.height / 2;
      for (const control of host.querySelectorAll<HTMLElement>(
        'button[matListItemMeta], mat-slide-toggle, mat-radio-button, mat-select',
      )) {
        const row = control.closest('mat-list-item')!;
        expect(
          Math.abs(
            center(control.getBoundingClientRect()) -
              center(row.getBoundingClientRect()),
          ),
        ).toBeLessThanOrEqual(1);
      }
      fixture.detectChanges();
      await fixture.whenStable();
      const value = host.querySelector('.mat-mdc-select-value-text')!;
      const selectBox = host.querySelector('mat-select')!;
      expect(
        Math.abs(
          center(value.getBoundingClientRect()) -
            center(selectBox.getBoundingClientRect()),
        ),
      ).toBeLessThanOrEqual(1);

      const select = fixture.debugElement.query(By.directive(MatSelect))
        .componentInstance as MatSelect;
      select.open();
      fixture.detectChanges();
      await fixture.whenStable();

      const panel = select.panel.nativeElement.getBoundingClientRect();
      const card = host.querySelector('mat-card')!.getBoundingClientRect();
      expect(panel.width).toBe(140);
      expect(panel.left).toBeGreaterThanOrEqual(card.left);
      expect(panel.right).toBeLessThanOrEqual(card.right);
      select.close();
    });
  }

  it('keeps controls inside a narrow card and separates successive groups', async () => {
    const fixture = TestBed.createComponent(SettingsLayoutFixture);
    const host = fixture.nativeElement as HTMLElement;
    host.style.width = '450px';
    fixture.detectChanges();
    await fixture.whenStable();
    const card = host.querySelector('mat-card')!.getBoundingClientRect();
    const select = host.querySelector('mat-select')!.getBoundingClientRect();
    expect(select.width).toBe(140);
    expect(select.right).toBeLessThan(card.right);
    const radio = host
      .querySelector('mat-radio-button')!
      .getBoundingClientRect();
    expect(radio.right).toBeLessThan(card.right);
    const groups = host.querySelectorAll('section');
    expect(
      groups[1].getBoundingClientRect().top -
        groups[0].getBoundingClientRect().bottom,
    ).toBe(16);
  });
});
