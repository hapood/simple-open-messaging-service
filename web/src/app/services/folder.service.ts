import { Injectable, inject, signal, effect } from '@angular/core';
import { UserService } from './user.service';
import { PreferenceStore } from './preference-store.service';

/** Folder type rule — reuses the thread type dimension. */
export type FolderTypeFilter = 'ALL' | 'P2P' | 'GROUP'

/**
 * Folder status rule — scopes a folder to a per-user status dimension. 'NONE' = no
 * status restriction. Extensible: add 'MUTED' once the mute feature is wired through
 * (the ThreadParticipant.muted column exists but is not yet exposed or toggleable).
 */
export type FolderStatusFilter = 'NONE' | 'UNREAD'

/** A user-defined chat folder. Persisted in the account-scoped client preference store. */
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
 * client preference database, with no backend involvement.
 */
@Injectable({ providedIn: 'root' })
export class FolderService {
  private readonly _folders = signal<ChatFolder[]>([])
  readonly folders = this._folders.asReadonly()
  private readonly userService = inject(UserService)
  private readonly preferences = inject(PreferenceStore)
  /** Previous sessionProfile id seen by the session-end effect (null = no logged-in user). */
  private prevSessionId: number | null = null

  private seq = 0
  private loadRevision = 0

  constructor() {
    // Drop the in-memory list on logout/account switch so thread ids never cross account boundaries.
    effect(() => {
      const id = this.userService.sessionProfile()?.id ?? null
      if (id === this.prevSessionId) return
      this.prevSessionId = id
      this.loadRevision++
      if (id === null) this._folders.set([])
      else void this.load(id, this.loadRevision)
    })
  }

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

  private async load(userId: number, revision: number): Promise<void> {
    const parsed =
      (await this.preferences.get<Partial<ChatFolder>[]>(`account:${userId}`, STORAGE_KEY)) ?? []
    if (
      revision !== this.loadRevision ||
      this.userService.sessionProfile()?.id !== userId
    ) return
    this._folders.set(parsed.map((f): ChatFolder => ({
        id: f.id ?? '',
        name: f.name ?? '',
        typeFilter: f.typeFilter ?? 'ALL',
        statusFilter: f.statusFilter ?? 'NONE',
        includedIds: f.includedIds ?? [],
        excludedIds: f.excludedIds ?? [],
        order: f.order ?? 0,
      })))
  }

  private persist() {
    const userId = this.userService.sessionProfile()?.id
    if (userId == null) return
    void this.preferences.set(`account:${userId}`, STORAGE_KEY, this._folders()).catch(() => {})
  }
}
