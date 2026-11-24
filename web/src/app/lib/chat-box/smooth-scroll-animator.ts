export interface SmoothScrollBounds {
  min: number;
  max: number;
}

export interface SmoothScrollRequest {
  /** Dynamically computes the target scrollTop each frame; return null if target became invalid. */
  getTargetTop: () => number | null;
  getCurrentTop: () => number;
  setTop: (top: number) => void;
  getBounds: () => SmoothScrollBounds;
  onComplete?: () => void;
  onCancel?: () => void;
}

export interface SmoothScrollAnimatorOptions {
  vMax?: number;
  aAccel?: number;
  aDecel?: number;
}

const DEFAULT_V_MAX = 2800; // px/s
const DEFAULT_A_ACCEL = 9000; // px/s^2
const DEFAULT_A_DECEL = 5500; // px/s^2
const MAX_DT_SEC = 0.05;
const SNAP_DISTANCE_PX = 0.5;
const SNAP_VELOCITY_PX_S = 60;

/**
 * Three-phase (accel / cruise / decel) interruptible rAF scroll animator.
 * Supports dynamic target re-evaluation each frame and seamless target switching
 * while preserving current velocity.
 */
export class SmoothScrollAnimator {
  private readonly vMax: number;
  private readonly aAccel: number;
  private readonly aDecel: number;

  private rafId = 0;
  private lastTimeMs = 0;
  private velocity = 0; // signed px/s
  private active: SmoothScrollRequest | null = null;

  constructor(options: SmoothScrollAnimatorOptions = {}) {
    this.vMax = options.vMax ?? DEFAULT_V_MAX;
    this.aAccel = options.aAccel ?? DEFAULT_A_ACCEL;
    this.aDecel = options.aDecel ?? DEFAULT_A_DECEL;
  }

  get isRunning(): boolean {
    return this.active !== null;
  }

  start(request: SmoothScrollRequest): void {
    const wasRunning = this.active !== null;
    this.active = request;
    if (!wasRunning) {
      this.velocity = 0;
      this.lastTimeMs = performance.now();
      this.scheduleNextFrame();
    }
  }

  cancel(): void {
    if (!this.active) return;
    const req = this.active;
    this.stopInternal();
    req.onCancel?.();
  }

  dispose(): void {
    this.stopInternal();
  }

  private stopInternal(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.active = null;
    this.velocity = 0;
    this.lastTimeMs = 0;
  }

  private scheduleNextFrame(): void {
    this.rafId = requestAnimationFrame((nowMs) => {
      this.rafId = 0;
      this.step(nowMs);
    });
  }

  private step(nowMs: number): void {
    const req = this.active;
    if (!req) return;

    const rawDt = (nowMs - this.lastTimeMs) / 1000;
    this.lastTimeMs = nowMs;
    const dt = Math.min(Math.max(rawDt, 0.001), MAX_DT_SEC);

    const rawTarget = req.getTargetTop();
    if (rawTarget === null) {
      this.cancel();
      return;
    }

    const bounds = req.getBounds();
    const target = Math.min(Math.max(rawTarget, bounds.min), bounds.max);
    const current = req.getCurrentTop();
    const remaining = target - current;

    if (
      Math.abs(remaining) <= SNAP_DISTANCE_PX &&
      Math.abs(this.velocity) <= SNAP_VELOCITY_PX_S
    ) {
      req.setTop(target);
      this.stopInternal();
      req.onComplete?.();
      return;
    }

    const dir = remaining >= 0 ? 1 : -1;

    if (this.velocity !== 0 && Math.sign(this.velocity) !== dir) {
      // Moving away from new target: decelerate toward 0 first.
      const dv = this.aDecel * dt;
      if (Math.abs(this.velocity) <= dv) {
        this.velocity = 0;
      } else {
        this.velocity -= Math.sign(this.velocity) * dv;
      }
    } else {
      const speed = Math.abs(this.velocity);
      const stopDist = (speed * speed) / (2 * this.aDecel);
      if (Math.abs(remaining) <= stopDist) {
        // Decelerate phase
        const nextSpeed = Math.max(0, speed - this.aDecel * dt);
        this.velocity = dir * nextSpeed;
      } else if (speed < this.vMax) {
        // Accelerate phase
        const nextSpeed = Math.min(this.vMax, speed + this.aAccel * dt);
        this.velocity = dir * nextSpeed;
      } else {
        // Cruise phase
        this.velocity = dir * this.vMax;
      }
    }

    const delta = this.velocity * dt;
    let next = current + delta;

    // Prevent overshooting target when moving toward it
    if (dir > 0 && next >= target) {
      next = target;
      req.setTop(next);
      this.stopInternal();
      req.onComplete?.();
      return;
    }
    if (dir < 0 && next <= target) {
      next = target;
      req.setTop(next);
      this.stopInternal();
      req.onComplete?.();
      return;
    }

    // Boundary clamp: if we hit min/max and are still trying to move outward, stop immediately
    if (next <= bounds.min && dir < 0) {
      req.setTop(bounds.min);
      this.stopInternal();
      req.onComplete?.();
      return;
    }
    if (next >= bounds.max && dir > 0) {
      req.setTop(bounds.max);
      this.stopInternal();
      req.onComplete?.();
      return;
    }

    req.setTop(next);
    this.scheduleNextFrame();
  }
}
