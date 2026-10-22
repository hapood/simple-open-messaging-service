import type { AccountStateCommands } from '../../../../shared/account-state-ipc';
import { tauriInvoke } from './runtime';

export function invokeAccountState<K extends keyof AccountStateCommands>(
  command: K,
  args: AccountStateCommands[K]['args'],
): Promise<AccountStateCommands[K]['result']> {
  return tauriInvoke<AccountStateCommands[K]['result']>(command, args);
}
