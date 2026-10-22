import { inject, Injectable } from '@angular/core';
import { NavStateMachineService } from './nav-state.service';
import { NativeMediaCacheService } from './native-media-cache.service';
import { WebdbService } from './webdb.service';

export interface LocalCacheStats {
  messageCount: number;
  mediaBytes: number | null;
}

/** Rebuildable chat-cache maintenance exposed through the Settings confirmation flow. */
@Injectable({ providedIn: 'root' })
export class LocalDataManagementService {
  private readonly nav = inject(NavStateMachineService);
  private readonly webdb = inject(WebdbService);
  private readonly media = inject(NativeMediaCacheService);

  async stats(): Promise<LocalCacheStats> {
    await this.media.refresh();
    return {
      messageCount: await this.webdb.countCachedMessages(),
      mediaBytes: this.media.available ? this.media.info().usedBytes : null,
    };
  }

  async clearChatCache(): Promise<void> {
    // Closing every descendant destroys ChatBoxes first. The Webdb barrier then rejects new admissions,
    // waits for already-admitted operations, and replaces only the message database/table.
    this.nav.returnToThreadList();
    await this.webdb.recreateMessageCache();
    await this.media.clear();
  }
}
