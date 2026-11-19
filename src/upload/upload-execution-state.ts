import { AsyncLocalStorage } from 'node:async_hooks';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

type Phase = 'running' | 'cancelling' | 'committing';
interface Execution {
  key: string;
  phase: Phase;
  target?: string;
  controller: AbortController;
  drained: Promise<void>;
  release(): void;
}

/** Single-process execution ownership. Commands either transition now or fail; none queue. */
export class UploadExecutionState {
  private readonly active = new Map<string, Execution>();
  private readonly context = new AsyncLocalStorage<Execution>();

  private conflict(message = 'upload execution is busy'): never {
    throw new BusinessException(BusinessCode.ALREADY_EXISTS, message, 409);
  }

  private create(key: string, phase: Phase, target?: string): Execution {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      key,
      phase,
      target,
      controller: new AbortController(),
      drained,
      release,
    };
  }

  async run<T>(
    key: string,
    operation: () => Promise<T>,
    target?: string,
  ): Promise<T> {
    if (this.active.has(key)) this.conflict();
    const execution = this.create(key, 'running', target);
    this.active.set(key, execution);
    try {
      return await this.context.run(execution, operation);
    } finally {
      execution.release();
      if (this.active.get(key) === execution) this.active.delete(key);
    }
  }

  async cancel<T>(
    key: string,
    operation: () => Promise<T>,
    invalidate: () => void,
    target?: string,
  ): Promise<T> {
    const previous = this.active.get(key);
    if (
      previous &&
      (previous.phase !== 'running' ||
        (target !== undefined && previous.target !== target))
    )
      this.conflict();
    const cancellation = this.create(key, 'cancelling', target);
    // Synchronous transition closes admission before abort callbacks or any await.
    this.active.set(key, cancellation);
    try {
      previous?.controller.abort();
      try {
        invalidate();
      } finally {
        // Even a failing adapter callback must not reopen admission while resources are live.
        // This drains already-started operations; commands never wait for a turn.
        await previous?.drained;
      }
      return await this.context.run(cancellation, operation);
    } finally {
      cancellation.release();
      if (this.active.get(key) === cancellation) this.active.delete(key);
    }
  }

  signal(): AbortSignal {
    this.assertCurrent();
    return this.context.getStore()!.controller.signal;
  }

  assertCurrent(): void {
    const execution = this.context.getStore();
    if (!execution) this.conflict('upload execution context is missing');
    if (execution.controller.signal.aborted)
      this.conflict('upload execution was cancelled');
    if (this.active.get(execution.key) !== execution)
      this.conflict('upload execution is no longer current');
  }

  /** Once the transaction is admitted, cancellation must not pretend it can retract a message. */
  beginCommit(): void {
    this.assertCurrent();
    const execution = this.context.getStore();
    if (!execution || execution.phase !== 'running')
      this.conflict('upload cannot commit in this phase');
    execution.phase = 'committing';
  }
}
