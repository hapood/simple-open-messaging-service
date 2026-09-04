import { Injectable } from '@nestjs/common';
import type {
  DurableAsyncTaskHandler,
  DurableTask,
} from './durable-task.types.js';

/** Routes async durable task execution by stable task type. */
@Injectable()
export class DurableAsyncTaskDispatcherService {
  private readonly handlers = new Map<string, DurableAsyncTaskHandler>();

  get supportedTaskTypes(): string[] {
    return [...this.handlers.keys()];
  }

  register(handler: DurableAsyncTaskHandler): () => void {
    if (!/^[A-Z][A-Z0-9_]*$/.test(handler.taskType))
      throw new Error(`invalid async durable task type: ${handler.taskType}`);
    if (this.handlers.has(handler.taskType))
      throw new Error(
        `async durable task handler already registered: ${handler.taskType}`,
      );
    this.handlers.set(handler.taskType, handler);
    return () => {
      if (this.handlers.get(handler.taskType) === handler)
        this.handlers.delete(handler.taskType);
    };
  }

  async execute(task: DurableTask): Promise<void> {
    const handler = this.handlers.get(task.taskType);
    if (!handler)
      throw new Error(
        `no async handler registered for durable task: ${task.taskType}`,
      );
    if (task.status !== 'ASYNC_PROCESSING')
      throw new Error('only ASYNC_PROCESSING tasks may be dispatched async');
    await handler.execute(task);
  }
}
