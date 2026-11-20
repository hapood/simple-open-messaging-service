/** Monotonic progress samples for presentation; no transport or scheduling ownership. */
export class TransferSpeedMeter {
  private readonly samples = new Map<
    string,
    { bytes: number; time: number; speed: number }
  >();

  update(id: string, bytes: number, now: number): number {
    const previous = this.samples.get(id);
    if (!previous || bytes < previous.bytes) {
      this.samples.set(id, { bytes, time: now, speed: 0 });
      return 0;
    }
    if (bytes === previous.bytes) return this.read(id, now);
    const elapsed = now - previous.time;
    const speed = elapsed > 0 ? ((bytes - previous.bytes) * 1000) / elapsed : 0;
    this.samples.set(id, { bytes, time: now, speed });
    return speed;
  }

  read(id: string, now: number): number {
    const sample = this.samples.get(id);
    return sample && now - sample.time < 3000 ? sample.speed : 0;
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.samples.keys())
      if (!ids.has(id)) this.samples.delete(id);
  }
}
