import { Injectable } from '@angular/core';

/**
 * Minimal imperative toast — used for graceful-degradation warnings from push/subscription paths
 * (e.g. "Web Push permission denied — you'll only get messages while the app is open"). Rendered
 * directly into the DOM rather than via an Angular component so it needs no template wiring (the app
 * shell is just `<router-outlet />`) and bypasses change detection (this app is zoneless — a CD-free
 * imperative popup is the clean fit). Heights in integer px per the project CSS rule.
 *
 * The caller passes an already-translated string (the push service resolves the transloco key), so this
 * service has no i18n dependency itself.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private container?: HTMLDivElement;

  /** Show a warning toast (amber). Auto-dismisses after 4s. */
  warn(message: string): void {
    this.show(message, 'warn');
  }

  /** Show an info toast (neutral). Auto-dismisses after 4s. */
  info(message: string): void {
    this.show(message, 'info');
  }

  private show(message: string, kind: 'warn' | 'info'): void {
    if (typeof document === 'undefined') return;
    const container = this.ensureContainer();
    const el = document.createElement('div');
    el.textContent = message;
    el.setAttribute('role', kind === 'warn' ? 'alert' : 'status');
    Object.assign(el.style, this.styles(kind));
    container.appendChild(el);
    // Animate in.
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translate(-50%, 0)'; });
    // Auto-dismiss.
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translate(-50%, -8px)';
      setTimeout(() => el.remove(), 250);
    }, 4000);
  }

  private ensureContainer(): HTMLDivElement {
    if (this.container && document.body.contains(this.container)) return this.container;
    const c = document.createElement('div');
    Object.assign(c.style, {
      position: 'fixed',
      top: '16px',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: '10000',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      alignItems: 'center',
      pointerEvents: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(c);
    this.container = c;
    return c;
  }

  private styles(kind: 'warn' | 'info'): Partial<CSSStyleDeclaration> {
    const bg = kind === 'warn' ? '#3a2a12' : '#1f1d27';
    const border = kind === 'warn' ? '#a8740c' : '#3c3947';
    return {
      maxWidth: '480px',
      padding: '10px 16px',
      borderRadius: '8px',
      background: bg,
      color: '#ffffff',
      fontSize: '14px',
      lineHeight: '20px',
      border: `1px solid ${border}`,
      boxShadow: '0 4px 16px rgba(0, 0, 0, 0.25)',
      opacity: '0',
      transform: 'translate(-50%, -8px)',
      transition: 'opacity 250ms ease, transform 250ms ease',
      pointerEvents: 'auto',
      whiteSpace: 'normal',
      wordBreak: 'break-word',
    } satisfies Partial<CSSStyleDeclaration>;
  }
}
