/** Server-execution byte rate. Resumed bytes establish a baseline, never count as new IO. */
export class DownloadSpeed {
  private baseline: { at: number; bytes: number } | undefined;
  private samples: Array<{ at: number; bytes: number }> = [];

  report(bytes: number, now = performance.now()): void {
    if (!Number.isFinite(bytes) || bytes < 0) return;
    if (
      !this.baseline ||
      bytes < (this.samples.at(-1)?.bytes ?? this.baseline.bytes)
    ) {
      this.baseline = { at: now, bytes };
      this.samples = [];
      return;
    }
    const last = this.samples.at(-1);
    if (last && now - last.at < 250) last.bytes = bytes;
    else this.samples.push({ at: now, bytes });
    this.trim(now);
  }

  value(now = performance.now()): number {
    this.trim(now);
    if (!this.baseline) return 0;
    const elapsed = now - this.baseline.at;
    const latest = this.samples.at(-1)?.bytes ?? this.baseline.bytes;
    return elapsed > 0
      ? Math.max(
          0,
          Math.round(((latest - this.baseline.bytes) * 1000) / elapsed),
        )
      : 0;
  }

  private trim(now: number): void {
    while (this.samples.length && this.samples[0].at <= now - 2000) {
      this.baseline = this.samples.shift();
    }
  }
}
