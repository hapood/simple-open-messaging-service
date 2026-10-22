import type { AccountState, AccountSelfProfile, AccountComposerDraft } from './account-state.js';

/** Reviewed IPC argument/result contracts. Failures reject; no success-shaped fallback. */
export interface AccountStateCommands {
  native_db_initialize_account_state: {
    args: { userId: number };
    result: void;
  };
  native_db_read_account_state: {
    args: { userId: number };
    result: AccountState;
  };
  native_db_write_self_profile: {
    args: { userId: number; profile: AccountSelfProfile };
    result: void;
  };
  native_db_advance_intent_request_read: {
    args: { userId: number; observedEndId: string };
    result: AccountState;
  };
  native_db_write_composer_drafts: {
    args: { userId: number; drafts: AccountComposerDraft[] };
    result: void;
  };
}

/** Writes own only their named fields, preserving all other account state. */
export interface AccountStateStorage {
  initializeAccountState(): Promise<void>;
  readAccountState(): Promise<AccountState>;
  advanceIntentRequestRead(observedEndId: string): Promise<AccountState>;
  writeSelfProfile(profile: AccountSelfProfile): Promise<void>;
  writeComposerDrafts(drafts: AccountComposerDraft[]): Promise<void>;
}
