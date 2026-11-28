import { spring } from 'motion';

/** Read at the point of use so newly requested animations respect the current preference. */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined'
    && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

type MotionTarget = Record<string, string | number>;
type RetargetOptions = {
  duration?: number;
  type?: 'spring' | 'tween';
  stiffness?: number;
  damping?: number;
  onComplete?: () => void;
};

/** Owns one interruptible group of CSS properties. Targets are also written as resting inline styles,
 * so completing/cancelling WAAPI cannot reveal an obsolete CSS base. Use separate owners for independent
 * property groups. A replacement samples the rendered values BEFORE cancelling the previous animation. */
export class InterruptibleMotion {
  private animation?: Animation;
  private generation = 0;
  private disposed = false;
  private finish?: () => void;
  private readonly preference = typeof matchMedia === 'undefined'
    ? undefined
    : matchMedia('(prefers-reduced-motion: reduce)');
  private readonly preferenceChanged = (): void => {
    if (this.preference?.matches) this.finish?.();
  };

  constructor() {
    this.preference?.addEventListener('change', this.preferenceChanged);
  }

  retarget(el: HTMLElement, target: MotionTarget, options: RetargetOptions = {}): void {
    if (this.disposed) return;
    const visual = getComputedStyle(el);
    const from: Record<string, string> = {};
    for (const property of Object.keys(target)) {
      from[property] = visual.getPropertyValue(property).trim();
    }
    this.cancel();
    const generation = this.generation;
    for (const [property, value] of Object.entries(target)) {
      el.style.setProperty(property, String(value));
    }
    const finish = (): void => {
      if (this.disposed || generation !== this.generation) return;
      this.cancel();
      options.onComplete?.();
    };
    this.finish = finish;
    if (this.preference?.matches || options.duration === 0) {
      finish();
      return;
    }
    let duration = (options.duration ?? 0.3) * 1000;
    let easing = 'cubic-bezier(0.2, 0, 0, 1)';
    if (options.type === 'spring') {
      // Sample Motion's spring into a native easing curve. Native WAAPI leaves resting styles alone,
      // including when an old finish event was queued immediately before a retarget.
      const generator = spring({ keyframes: [0, 1], stiffness: options.stiffness ?? 140, damping: options.damping ?? 22 });
      const samples: number[] = [];
      for (let time = 0; time <= 10000; time += 10) {
        const sample = generator.next(time);
        samples.push(sample.value);
        if (sample.done) break;
      }
      duration = (samples.length - 1) * 10;
      easing = `linear(${samples.join(',')})`;
    }
    this.animation = el.animate([from, target], { duration, easing });
    this.animation.onfinish = finish;
  }

  /** Invalidates completion callbacks without publishing a completion. Resting styles remain intact. */
  cancel(): void {
    this.generation++;
    this.finish = undefined;
    if (this.animation) {
      this.animation.onfinish = null;
      this.animation.cancel();
      this.animation = undefined;
    }
  }

  destroy(): void {
    this.disposed = true;
    this.cancel();
    this.preference?.removeEventListener('change', this.preferenceChanged);
  }
}

/** Resolve theme-aware registered color variables and spring from the owner's current visual state. */
export function springGradient(
  owner: InterruptibleMotion,
  el: HTMLElement,
  palette: { from: string; to: string; ic: string },
  opts: { stiffness?: number; damping?: number } = {},
): void {
  const cs = getComputedStyle(el);
  const read = (name: string): string => cs.getPropertyValue(name).trim();
  owner.retarget(el, {
    '--g-from': read(palette.from),
    '--g-to': read(palette.to),
    '--ic': read(palette.ic),
  }, { type: 'spring', stiffness: opts.stiffness ?? 140, damping: opts.damping ?? 22 });
}
