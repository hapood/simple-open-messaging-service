import {
  Component,
  ElementRef,
  HostListener,
  inject,
  input,
  signal,
} from '@angular/core';

@Component({
  selector: 'app-field-help',
  template: `<button
      type="button"
      class="help"
      [attr.aria-label]="label()"
      [attr.aria-expanded]="open()"
      (click)="open.set(!open())"
    >
      ?
    </button>
    @if (open()) {
      <span class="bubble" role="note">{{ text() }}</span>
    }`,
  styles: `
    :host {
      position: relative;
      display: inline-flex;
      vertical-align: middle;
    }
    .help {
      display: grid;
      place-items: center;
      width: 18px;
      height: 18px;
      padding: 0;
      border: 1px solid var(--app-border-strong);
      border-radius: 50%;
      background: transparent;
      color: var(--app-text-muted);
      font: 11px/16px system-ui;
      cursor: pointer;
    }
    .help:focus-visible {
      outline: 2px solid var(--app-focus-ring);
      outline-offset: 2px;
    }
    .bubble {
      position: absolute;
      top: 26px;
      left: -80px;
      z-index: 20;
      width: 260px;
      max-width: 70vw;
      padding: 12px;
      background: var(--app-surface-elevated);
      border: 1px solid var(--app-border);
      border-radius: 10px;
      box-shadow: var(--app-shadow-2);
      color: var(--app-text);
      font: 12px/20px system-ui;
      white-space: normal;
    }
  `,
})
export class FieldHelpComponent {
  readonly label = input.required<string>();
  readonly text = input.required<string>();
  readonly open = signal(false);
  private readonly element = inject(ElementRef<HTMLElement>);
  @HostListener('document:click', ['$event']) outside(event: MouseEvent) {
    if (!this.element.nativeElement.contains(event.target as Node))
      this.open.set(false);
  }
  @HostListener('document:keydown.escape') escape() {
    this.open.set(false);
  }
}
