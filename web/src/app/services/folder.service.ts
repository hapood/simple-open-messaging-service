import { Injectable, signal } from '@angular/core';

/** Folder type rule — reuses the thread type dimension. */
export type FolderTypeFilter = 'ALL' | 'P2P' | 'GROUP'

/** A user-defined chat folder. Persisted to localStorage (soms.chatFolders). */
export interface ChatFolder {
  id: string
  name: string
  /** type rule; 'ALL' = no type restriction */
  typeFilter: FolderTypeFilter
  /** manually included ConversationItem.id */
  includedIds: number[]
  /** manually excluded ConversationItem.id */
  excludedIds: number[]
  order: number
}

const STORAGE_KEY = 'soms.chatFolders'

/**
 * A thread belongs to a folder ⇔ NOT excluded AND (matches the type rule OR is
 * manually included) — same semantics as Telegram folders.
 */
export function inFolder(thread: { id: number; type: string }, folder: ChatFolder): boolean {
  if (folder.excludedIds.includes(thread.id)) return false
  const typeMatch = folder.typeFilter === 'ALL' || thread.type === folder.typeFilter
  return typeMatch || folder.includedIds.includes(thread.id)
}

/**
 * Holds the user's chat folders. Desktop-only feature; config lives in the
 * browser (localStorage), no backend involvement. Mirrors the signal+readonly
 * pattern of ConversationListService and the `soms.*` localStorage prefix of listWidth.
 */
@Injectable({ providedIn: 'root' })
export class FolderService {
  private readonly _folders = signal<ChatFolder[]>(this.load())
  readonly folders = this._folders.asReadonly()

  private seq = 0

  getById(id: string): ChatFolder | undefined {
    return this._folders().find(f => f.id === id)
  }

  create(data: { name: string; typeFilter: FolderTypeFilter; includedIds?: number[]; excludedIds?: number[] }): ChatFolder {
    const list = this._folders()
    const folder: ChatFolder = {
      id: this.genId(),
      name: data.name,
      typeFilter: data.typeFilter,
      includedIds: data.includedIds ?? [],
      excludedIds: data.excludedIds ?? [],
      order: list.length ? Math.max(...list.map(f => f.order)) + 1 : 0,
    }
    this._folders.update(l => l.concat([folder]))
    this.persist()
    return folder
  }

  update(id: string, patch: Partial<Omit<ChatFolder, 'id'>>) {
    this._folders.update(l => l.map(f => (f.id === id ? { ...f, ...patch } : f)))
    this.persist()
  }

  remove(id: string) {
    this._folders.update(l => l.filter(f => f.id !== id))
    this.persist()
  }

  private genId(): string {
    return 'f' + Date.now().toString(36) + (this.seq++).toString(36)
  }

  private load(): ChatFolder[] {
    if (typeof localStorage === 'undefined') return []
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as ChatFolder[]) : []
    } catch {
      return []
    }
  }

  private persist() {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._folders()))
  }
}
