import { isAndroidNative, tauriInvoke } from './runtime';

declare global {
  interface Window {
    /** Per-window launch identity installed by Rust before any page script executes. */
    __SOMS_LAUNCH_GENERATION__?: string;
  }
}

type LaunchStage = 'session' | 'config' | 'interface';
type LaunchUpdate =
  | { kind: 'stage'; stage: LaunchStage }
  | { kind: 'theme'; dark: boolean }
  | { kind: 'ready' }
  | { kind: 'failed' };

export function hasNativeLaunch(): boolean {
  return (
    !!window.__SOMS_LAUNCH_GENERATION__ ||
    (isAndroidNative() && !!window.SomsShell?.finishSplash)
  );
}

async function report(update: LaunchUpdate): Promise<void> {
  const generation = window.__SOMS_LAUNCH_GENERATION__;
  if (!generation) return;
  await tauriInvoke('launch_update', { generation, update });
}

export function setLaunchStage(stage: LaunchStage): void {
  window.SomsShell?.setSplashStage?.(stage);
  void report({ kind: 'stage', stage }).catch(() => {});
}

export async function setLaunchTheme(dark: boolean): Promise<void> {
  window.SomsShell?.setSplashTheme?.(dark);
  // Theme presentation must not prevent application bootstrap if a native adapter fails.
  await report({ kind: 'theme', dark }).catch(() => {});
}

export async function finishNativeLaunch(): Promise<void> {
  window.SomsShell?.finishSplash?.();
  await report({ kind: 'ready' });
}

export function failNativeLaunch(error: unknown): void {
  console.error('[bootstrap] failed', error);
  void report({ kind: 'failed' }).catch(() => {});
}

/** Yield two rendering opportunities after the routed DOM has settled. CPU load delays readiness
 * rather than allowing a wall-clock timer to uncover an unfinished page. */
export async function waitForLaunchPaint(
  whenStable: () => Promise<unknown>,
  frame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): Promise<void> {
  await whenStable();
  await new Promise<void>((resolve) => frame(() => frame(() => resolve())));
}
