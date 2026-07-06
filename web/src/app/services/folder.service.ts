import { Injectable, signal } from '@angular/core';

/** Folder type rule — reuses the thread type dimension. */
export type FolderTypeFilter = 'ALL' | 'P2P' | 'GROUP'

/**
 * Folder status rule — scopes a folder to a per-user status dimension. 'NONE' = no
 * status restriction. Extensible: add 'MUTED' once the mute feature is wired through
 * (the ThreadParticipant.muted column exists but is not yet exposed or toggleable).
 */
export type FolderStatusFilter = 'NONE' | 'UNREAD'

/** A user-defined chat folder. Persisted to localStorage (soms.chatFolders). */
export interface ChatFolder {
  id: string
  name: string
  /** type rule; 'ALL' = no type restriction */
  typeFilter: FolderTypeFilter
  /** status rule, AND'd on top of the type rule for auto-included threads; 'NONE' = no status restriction */
  statusFilter: FolderStatusFilter
  /** manually included ConversationItem.id */
  includedIds: number[]
  /** manually excluded ConversationItem.id */
  excludedIds: number[]
  order: number
}

const STORAGE_KEY = 'soms.chatFolders'

/**
 * A thread belongs to a folder ⇔ NOT excluded AND (manually included OR matches
 * the type rule) AND — for threads auto-included by the type rule only — matches
 * the status rule. Manually-pinned threads bypass the status gate, mirroring how
 * they already bypass the type rule. Same override shape as Telegram folders.
 */
export function inFolder(
  thread: { id: number; type: string; unreadCount?: number },
  folder: ChatFolder,
): boolean {
  if (folder.excludedIds.includes(thread.id)) return false
  if (folder.includedIds.includes(thread.id)) return true
  const typeMatch = folder.typeFilter === 'ALL' || thread.type === folder.typeFilter
  if (!typeMatch) return false
  if (folder.statusFilter === 'UNREAD') return (thread.unreadCount ?? 0) > 0
  return true
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

  create(data: { name: string; typeFilter: FolderTypeFilter; statusFilter?: FolderStatusFilter; includedIds?: number[]; excludedIds?: number[] }): ChatFolder {
    const list = this._folders()
    const folder: ChatFolder = {
      id: this.genId(),
      name: data.name,
      typeFilter: data.typeFilter,
      statusFilter: data.statusFilter ?? 'NONE',
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
      if (!raw) return []
      // Back-fill every field so folders persisted before a field was added
      // (e.g. statusFilter) coerce to a valid ChatFolder instead of shipping undefined.
      const parsed = JSON.parse(raw) as Partial<ChatFolder>[]
      return parsed.map((f): ChatFolder => ({
        id: f.id ?? '',
        name: f.name ?? '',
        typeFilter: f.typeFilter ?? 'ALL',
        statusFilter: f.statusFilter ?? 'NONE',
        includedIds: f.includedIds ?? [],
        excludedIds: f.excludedIds ?? [],
        order: f.order ?? 0,
      }))
    } catch {
      return []
    }
  }

  private persist() {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this._folders()))
  }
}
