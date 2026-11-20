import { defer } from 'rxjs';
import type { CbDemand, CbDemandResult } from './cb-source';
import { EdgeDemandState } from './edge-demand-state';

/** One window's entry opportunity. Visibility and renderer lifetime do not own it. */
export class EntryDemandOwner<T> {
  private state: 'available' | 'active' | 'failed' | 'consumed' = 'available';
  private readonly edge = new EdgeDemandState<T>();
  private generation = 0;

  constructor(private readonly request: () => CbDemand<T>) {}

  get ownsLocation(): boolean {
    return this.state !== 'consumed';
  }

  get loading(): boolean {
    return this.state === 'active';
  }

  get error(): unknown | null {
    return this.edge.error;
  }

  /** Ordinary demand checks may start the opportunity, but never retry an error. */
  start(deliver: (result: CbDemandResult<T>) => void): void {
    if (this.state !== 'available') return;
    this.subscribe(deliver);
  }

  /** Explicit retry keeps the same request closure and frozen entry coordinates. */
  retry(deliver: (result: CbDemandResult<T>) => void): void {
    if (this.state !== 'failed') return;
    this.subscribe(deliver);
  }

  /** Logical removal consumes both active work and any retry opportunity permanently. */
  retire(): void {
    this.state = 'consumed';
    this.generation++;
    this.edge.cancel();
    this.edge.error = null;
  }

  private subscribe(deliver: (result: CbDemandResult<T>) => void): void {
    const generation = ++this.generation;
    this.state = 'active';
    this.edge.error = null;
    this.edge.subscribe(defer(this.request), (result) => {
      if (generation !== this.generation || this.state !== 'active') return;
      if (result.kind === 'error') {
        this.state = 'failed';
        this.edge.error = result.error;
      } else {
        // Release ownership before delivery: a synchronous successor sees ordinary demand.
        this.state = 'consumed';
      }
      deliver(result);
    });
  }
}
