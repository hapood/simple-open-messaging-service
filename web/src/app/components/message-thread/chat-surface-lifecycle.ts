import { signal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

/** Conversation parameters and cancellation shared by bound capabilities.
 * Each capability owns its subscriptions and releases them in its unbind path. */
export interface ChatSurfaceBinding {
  readonly threadId: number;
  readonly signal: AbortSignal;
}

export type ChatSurfaceState =
  | { readonly phase: 'unbound' | 'destroyed' }
  | {
      readonly phase: 'bound';
      readonly binding: ChatSurfaceBinding;
      readonly foreground: boolean;
    };

/** Synchronous lifecycle authority. Loading/presentation belong to the message
 * surface. Cancellation and unbind delivery must never be deferred. */
export class ChatSurfaceLifecycle {
  private readonly value = signal<ChatSurfaceState>({ phase: 'unbound' });
  readonly state = this.value.asReadonly();
  private readonly changes = new BehaviorSubject<ChatSurfaceState>(
    this.value(),
  );
  readonly state$ = this.changes.asObservable();
  private abort?: AbortController;

  get binding(): ChatSurfaceBinding | undefined {
    const state = this.value();
    return state.phase === 'bound' ? state.binding : undefined;
  }

  bind(threadId: number): ChatSurfaceBinding {
    if (this.value().phase !== 'unbound')
      throw new Error('chat surface is not unbound');
    this.abort = new AbortController();
    const binding = { threadId, signal: this.abort.signal };
    this.publish({ phase: 'bound', binding, foreground: false });
    return binding;
  }

  activate(binding: ChatSurfaceBinding, foreground: boolean): void {
    const state = this.value();
    if (state.phase !== 'bound' || state.foreground === foreground) return;
    if (binding.signal.aborted) return;
    this.publish({ phase: 'bound', binding, foreground });
  }

  unbind(): void {
    if (this.value().phase !== 'bound') return;
    const abort = this.abort;
    this.abort = undefined;
    this.value.set({ phase: 'unbound' });
    try {
      abort?.abort();
    } finally {
      this.changes.next(this.value());
    }
  }

  destroy(): void {
    if (this.value().phase === 'destroyed') return;
    try {
      this.unbind();
    } finally {
      this.publish({ phase: 'destroyed' });
      this.changes.complete();
    }
  }

  private publish(state: ChatSurfaceState): void {
    this.value.set(state);
    this.changes.next(state);
  }
}
