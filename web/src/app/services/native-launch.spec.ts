import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  finishNativeLaunch,
  hasNativeLaunch,
  setLaunchStage,
  setLaunchTheme,
  waitForLaunchPaint,
} from './native-launch';

const originalTauri = window.__TAURI__;
const originalShell = window.SomsShell;
const originalGeneration = window.__SOMS_LAUNCH_GENERATION__;

afterEach(() => {
  window.__TAURI__ = originalTauri;
  window.SomsShell = originalShell;
  window.__SOMS_LAUNCH_GENERATION__ = originalGeneration;
  vi.restoreAllMocks();
});

describe('native launch renderer facts', () => {
  it('does not invoke desktop IPC without a native launch owner', async () => {
    delete window.__SOMS_LAUNCH_GENERATION__;
    delete window.SomsShell;
    const invoke = vi.fn();
    window.__TAURI__ = { core: { invoke } };
    expect(hasNativeLaunch()).toBe(false);
    await setLaunchTheme(true);
    setLaunchStage('session');
    await finishNativeLaunch();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('includes the native launch generation in each desktop report', async () => {
    window.__SOMS_LAUNCH_GENERATION__ = 'launch-1';
    const invoke = vi.fn().mockResolvedValue(undefined);
    window.__TAURI__ = { core: { invoke } };
    expect(hasNativeLaunch()).toBe(true);
    await setLaunchTheme(true);
    setLaunchStage('interface');
    await finishNativeLaunch();
    expect(invoke.mock.calls).toEqual([
      [
        'launch_update',
        { generation: 'launch-1', update: { kind: 'theme', dark: true } },
      ],
      [
        'launch_update',
        {
          generation: 'launch-1',
          update: { kind: 'stage', stage: 'interface' },
        },
      ],
      ['launch_update', { generation: 'launch-1', update: { kind: 'ready' } }],
    ]);
  });

  it('preserves the Android presentation bridge', async () => {
    delete window.__SOMS_LAUNCH_GENERATION__;
    const setSplashStage = vi.fn();
    const setSplashTheme = vi.fn();
    const finishSplash = vi.fn();
    window.SomsShell = {
      getSafeInsets: () => '{}',
      setSplashStage,
      setSplashTheme,
      finishSplash,
    };
    await setLaunchTheme(false);
    setLaunchStage('config');
    await finishNativeLaunch();
    expect(setSplashTheme).toHaveBeenCalledExactlyOnceWith(false);
    expect(setSplashStage).toHaveBeenCalledExactlyOnceWith('config');
    expect(finishSplash).toHaveBeenCalledOnce();
  });

  it('does not equate stability or the first animation frame with painted readiness', async () => {
    let stabilize!: () => void;
    const stable = new Promise<void>((resolve) => {
      stabilize = resolve;
    });
    const frames: FrameRequestCallback[] = [];
    const frame = vi.fn((callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    const ready = vi.fn();
    const painted = waitForLaunchPaint(() => stable, frame).then(ready);
    expect(frame).not.toHaveBeenCalled();
    stabilize();
    await Promise.resolve();
    expect(frame).toHaveBeenCalledTimes(1);
    expect(ready).not.toHaveBeenCalled();
    frames.shift()!(0);
    expect(ready).not.toHaveBeenCalled();
    frames.shift()!(16);
    await painted;
    expect(ready).toHaveBeenCalledOnce();
  });
});
