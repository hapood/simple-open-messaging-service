import { Injectable } from '@nestjs/common';
import type {
  DurableTask,
  DurableTaskExecutionResult,
  DurableTaskHandler,
} from './durable-task.types.js';

@Injectable()
export class DurableTaskDispatcherService {
  private readonly handlers = new Map<string, DurableTaskHandler>();

  get supportedTaskTypes(): readonly string[] {
    return [...this.handlers.keys()];
  }

  register(handler: DurableTaskHandler): () => void {
    if (!/^[A-Z][A-Z0-9_]*$/.test(handler.taskType)) {
      throw new TypeError('invalid durable task handler type');
    }
    if (this.handlers.has(handler.taskType)) {
      throw new Error(
        `durable task handler already registered: ${handler.taskType}`,
      );
    }
    this.handlers.set(handler.taskType, handler);

    return () => {
      if (this.handlers.get(handler.taskType) === handler) {
        this.handlers.delete(handler.taskType);
      }
    };
  }

  async execute(task: DurableTask): Promise<DurableTaskExecutionResult> {
    const handler = this.handlers.get(task.taskType);
    if (!handler) {
      throw new Error(
        `no handler registered for durable task: ${task.taskType}`,
      );
    }
    return handler.execute(task);
  }
}
