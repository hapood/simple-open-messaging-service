import type { CbSource } from '../../lib/chat-box/cb-source';
import type { CbItem } from '../../lib/chat-box/chat-box-scroller';
import type { ChatItemData } from '../message-cards/chat-item';

export class ForwardSnapshotSource implements CbSource<ChatItemData> {
  constructor(private readonly items: CbItem<ChatItemData>[]) {}

  async init(): Promise<CbItem<ChatItemData>[]> {
    return this.items;
  }

  async getOlder(): Promise<CbItem<ChatItemData>[]> {
    return [];
  }

  async getNewer(): Promise<CbItem<ChatItemData>[]> {
    return [];
  }

  getPending(): CbItem<ChatItemData>[] {
    return [];
  }

  pushLive(): void {}
  destroy(): void {}
}
