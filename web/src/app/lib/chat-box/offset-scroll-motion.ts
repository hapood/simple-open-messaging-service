export interface OffsetScrollMotionOptions {
  /** Read the continuous visual coordinate, not a rounded or clamped DOM value. */
  getOffset: () => number;
  /** Publish a continuous coordinate; mapping it to scroll/transform is caller-owned. */
  setOffset: (offset: number) => void;
  /** Called on arrival or snap unless its setter cancels or starts another trip. */
  onFinish?: () => void;
}

const MAX_SPEED = 2800; // px/s
const ACCELERATION = 9000; // px/s^2
const DECELERATION = 5500; // px/s^2
const MAX_DT_SECONDS = 0.05;

/**
 * Bounds-independent, signed acceleration/cruise/deceleration motion.
 * Retargeting preserves velocity, including the stopping distance when reversing.
 * The caller owns reduced-motion policy (use snap), bounds and coordinate mapping.
 * Callbacks must read/write finite, continuous offsets without clamping them.
 */
export class OffsetScrollMotion {
  private rafId: number | null = null;
  private running = false;
  private velocity = 0;
  private target: number | null = null;
  private lastTimeMs = 0;
  private generation = 0;

  constructor(private readonly options: OffsetScrollMotionOptions) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** Signed pixels per second. */
  get currentVelocity(): number {
    return this.velocity;
  }

  /** Last requested destination, retained after arrival/snap; null after cancel. */
  get targetOffset(): number | null {
    return this.target;
  }

  /** Start or retarget without changing position, velocity or the active clock. */
  setTarget(offset: number): void {
    this.requireFinite(offset);
    this.target = offset;
    if (this.running) return;
    // Starting from rest takes ownership from any completion still publishing.
    this.generation++;
    this.running = true;
    this.lastTimeMs = performance.now();
    this.schedule();
  }

  /** Stop/reset silently without changing the caller's position. */
  cancel(): void {
    this.stop();
    this.target = null;
  }

  /** Immediate completion, suitable for reduced motion. */
  snap(offset: number): void {
    this.requireFinite(offset);
    this.stop();
    this.target = offset;
    const generation = this.generation;
    this.options.setOffset(offset);
    if (generation === this.generation) this.options.onFinish?.();
  }

  /**
   * Shift the destination by delta after the caller has shifted its current
   * coordinate by the same delta (for example, after prepending content).
   * Does not write an offset, alter velocity, restart time or fire onFinish.
   * Call synchronously with the caller's rebase, before the next animation frame.
   */
  rebase(delta: number): void {
    this.requireFinite(delta);
    if (this.target === null) return;
    const target = this.target + delta;
    this.requireFinite(target);
    this.target = target;
  }

  private requireFinite(offset: number): void {
    if (!Number.isFinite(offset)) {
      throw new RangeError('OffsetScrollMotion requires finite offsets');
    }
  }

  private stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.running = false;
    this.velocity = 0;
    this.lastTimeMs = 0;
    this.generation++;
  }

  private schedule(): void {
    const generation = this.generation;
    this.rafId = requestAnimationFrame((nowMs) => {
      if (generation !== this.generation) return;
      this.rafId = null;
      this.step(nowMs);
    });
  }

  private step(nowMs: number): void {
    if (!this.running || this.target === null) return;
    // A duplicate, backwards or invalid timestamp must not manufacture motion.
    if (!Number.isFinite(nowMs) || nowMs <= this.lastTimeMs) {
      this.schedule();
      return;
    }
    const dt = Math.min((nowMs - this.lastTimeMs) / 1000, MAX_DT_SECONDS);
    this.lastTimeMs = nowMs;
    const readGeneration = this.generation;
    const current = this.options.getOffset();
    // A getter can cancel or replace this trip, even while returning stale data.
    if (readGeneration !== this.generation) return;
    if (!Number.isFinite(current)) {
      this.cancel();
      return;
    }
    const target = this.target;
    const result = this.integrate(current, target, dt);
    if (result.finished) this.stop();
    const generation = this.generation;
    this.options.setOffset(result.offset);
    // A setter may cancel/snap/restart; neither finish nor schedule the old trip.
    if (generation !== this.generation) return;
    if (result.finished) {
      this.options.onFinish?.();
    } else if (this.running) {
      this.schedule();
    }
  }

  private integrate(
    current: number,
    target: number,
    dt: number,
  ): { offset: number; finished: boolean } {
    let offset = current;
    let timeLeft = dt;

    // Integrate exactly to phase boundaries, rather than applying the final
    // velocity over the entire frame. In particular, braking still travels in
    // the old direction even when this frame includes the zero-velocity point.
    const advance = (
      acceleration: number,
      duration: number,
      finalVelocity: number,
    ): boolean => {
      const elapsed = Math.min(timeLeft, duration);
      offset +=
        this.velocity * elapsed + (acceleration * elapsed * elapsed) / 2;
      this.velocity += acceleration * elapsed;
      timeLeft -= elapsed;
      if (elapsed < duration) return false;
      this.velocity = finalVelocity;
      return true;
    };

    let distance = target - offset;
    const speed = Math.abs(this.velocity);
    const stoppingDistance = (speed * speed) / (2 * DECELERATION);
    if (
      speed > 0 &&
      (Math.sign(this.velocity) !== Math.sign(distance) ||
        stoppingDistance > Math.abs(distance))
    ) {
      // An unreachable nearer/reversed target is not an arrival: brake past it
      // if necessary, stop, then plan the return trip. Never clamp on crossing.
      if (
        !advance(
          -Math.sign(this.velocity) * DECELERATION,
          speed / DECELERATION,
          0,
        )
      ) {
        return { offset, finished: false };
      }
      distance = target - offset;
    }

    if (distance === 0 && this.velocity === 0) {
      return { offset: target, finished: true };
    }

    const direction = Math.sign(distance);
    const initialSpeed = Math.abs(this.velocity);
    // Solve distance = acceleration distance + braking distance. Long trips
    // cap the peak speed and spend the remaining distance cruising.
    const distanceToMaxSpeed =
      (MAX_SPEED * MAX_SPEED - initialSpeed * initialSpeed) /
        (2 * ACCELERATION) +
      (MAX_SPEED * MAX_SPEED) / (2 * DECELERATION);
    // Compare before multiplying distance so even very large finite coordinates
    // do not overflow the peak-speed calculation.
    const peakSpeed =
      Math.abs(distance) >= distanceToMaxSpeed
        ? MAX_SPEED
        : Math.sqrt(
            (2 * ACCELERATION * Math.abs(distance) +
              initialSpeed * initialSpeed) /
              (1 + ACCELERATION / DECELERATION),
          );
    const accelerationTime = Math.max(
      0,
      (peakSpeed - initialSpeed) / ACCELERATION,
    );
    const accelerationDistance =
      ((initialSpeed + peakSpeed) * accelerationTime) / 2;
    const brakingDistance = (peakSpeed * peakSpeed) / (2 * DECELERATION);
    const cruiseDistance = Math.max(
      0,
      Math.abs(distance) - accelerationDistance - brakingDistance,
    );

    if (
      !advance(
        direction * ACCELERATION,
        accelerationTime,
        direction * peakSpeed,
      ) ||
      !advance(
        0,
        peakSpeed > 0 ? cruiseDistance / peakSpeed : 0,
        direction * peakSpeed,
      ) ||
      !advance(-direction * DECELERATION, peakSpeed / DECELERATION, 0)
    ) {
      return { offset, finished: false };
    }
    // All phases completed: publish the exact requested value, not accumulated
    // floating-point integration error.
    return { offset: target, finished: true };
  }
}
