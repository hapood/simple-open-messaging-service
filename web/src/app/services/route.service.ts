import { Injectable, signal, Type } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { AvatarEditorComponent } from '../components/avatar-editor/avatar-editor.component';
import { FriendRequestsComponent } from '../components/friend-requests/friend-requests.component';
import { NewGroupComponent } from '../components/new-group/new-group.component';
import { FolderEditorComponent } from '../components/folder-editor/folder-editor.component';
import { EditProfileComponent } from '../components/edit-profile/edit-profile.component';
import { SessionsComponent } from '../components/sessions/sessions.component';
import { ConfirmDialogComponent } from '../components/confirm-dialog/confirm-dialog.component';
import { AppIconType } from '../components/icon/model';

export enum RoutePage {
  HOME, AUTH_LOGIN, AUTH_REGISTER
}

/**
 * Transient dialogs only. The navigation-bearing views (chat thread, peer profile, group info) are
 * router routes now (see app.routes.ts) — no longer managed here. `DlgRef` + `closeDialogAndAbove`
 * remain for these dialogs. CONFIRM is the generic destructive/confirming-action modal (not an editor),
 * reused by any caller that needs an app-level "are you sure?".
 */
export enum PopupType { FRIEND_REQUESTS, NEW_GROUP, FOLDER_EDITOR, EDIT_PROFILE, SESSIONS, AVATAR_EDITOR, CONFIRM }

const componentDict: Record<PopupType, Type<unknown>> = {
  [PopupType.FRIEND_REQUESTS]: FriendRequestsComponent,
  [PopupType.NEW_GROUP]: NewGroupComponent,
  [PopupType.FOLDER_EDITOR]: FolderEditorComponent,
  [PopupType.EDIT_PROFILE]: EditProfileComponent,
  [PopupType.SESSIONS]: SessionsComponent,
  [PopupType.AVATAR_EDITOR]: AvatarEditorComponent,
  [PopupType.CONFIRM]: ConfirmDialogComponent,
}

// per-popup input contracts — what each dialog's input() fields accept
export interface PopupInput {
  [PopupType.FRIEND_REQUESTS]: { subject?: Subject<any> }
  [PopupType.NEW_GROUP]: undefined
  [PopupType.FOLDER_EDITOR]: { folderId?: string }
  [PopupType.EDIT_PROFILE]: undefined
  [PopupType.SESSIONS]: undefined
  [PopupType.AVATAR_EDITOR]: { file: File },
  /** Generic confirm dialog. `messageKey` is required; the rest are optional presentation knobs. */
  [PopupType.CONFIRM]: {
    titleKey?: string
    messageKey: string
    messageParams?: Record<string, unknown>
    confirmKey?: string
    cancelKey?: string
    danger?: boolean
    icon?: AppIconType
  },
}

// per-popup result contracts — what a dialog passes back to its opener via closeDlg()
export interface PopupResult {
  [PopupType.FRIEND_REQUESTS]: undefined
  [PopupType.NEW_GROUP]: { groupId: number }
  [PopupType.FOLDER_EDITOR]: boolean
  [PopupType.EDIT_PROFILE]: boolean
  [PopupType.SESSIONS]: undefined
  // cropped File on Save; undefined on Cancel/back.
  [PopupType.AVATAR_EDITOR]: { file: File } | undefined,
  // true on confirm; undefined on cancel / system-back (treated identically by the caller).
  [PopupType.CONFIRM]: boolean | undefined,
}

export interface DlgInfo {
  component: Type<unknown>,
  inputs?: Record<string, unknown>
}

/**
 * Opaque handle to an open dialog, returned by {@link RouteService.popupDlg}. Pass it to
 * {@link RouteService.closeDialogAndAbove} to close that specific dialog (and its nested descendants)
 * from outside the dialog itself — e.g. when an event invalidates the conversation it was opened from.
 */
export interface DlgRef {
  /** internal id matching a DlgEntry */
  readonly id: number
}

interface DlgEntry {
  id: number
  info: DlgInfo
  onResult?: (result: unknown) => void
}

@Injectable({
  providedIn: 'root',
})
export class RouteService {
  private dlgStack: DlgEntry[] = []
  dlgList = signal<DlgInfo[]>([])

  /** Monotonic id source for {@link DlgRef} identity. */
  private nextDlgId = 0
  /**
   * Count of browser-history traversals we initiated ourselves (via closeDlg / closeDialogAndAbove) whose
   * resulting popstate must be ignored so we don't double-close. Each programmatic close fires exactly one
   * popstate (history.back or history.go), so this is a 1:1 counter per initiated traversal.
   */
  private selfBackPending = 0

  constructor(private router: Router) {
    // Each open dialog owns one history entry, so pressing back (system or
    // programmatic) closes the topmost dialog one at a time. Page navigation
    // correctness is handled by the route guards, not here.
    window.addEventListener('popstate', () => this.onPopStateEvent())
  }

  getPageRoute(page: RoutePage, params?: any) {
    let commands: string[] | undefined
    switch (page) {
      case RoutePage.HOME:
        commands = ['']
        break;
      case RoutePage.AUTH_LOGIN:
        commands = ['auth/login']
        break;
      case RoutePage.AUTH_REGISTER:
        commands = ['auth/register']
        break;
      default:
    }
    return commands
  }

  navigate(page: RoutePage, params?: any) {
    const commands = this.getPageRoute(page, params)
    if (commands) {
      this.router.navigate(commands)
    } else {
      console.error(`no page to navigate [${page}]`)
    }
  }

  redirect(page: RoutePage, params?: any) {
    const commands = this.getPageRoute(page, params)
    if (commands) {
      this.router.navigate(commands, { replaceUrl: true })
    } else {
      console.error(`no page to redirect [${page}]`)
    }
  }

  popupDlg<K extends PopupType>(
    popupType: K,
    inputs?: PopupInput[K],
    onResult?: (result: PopupResult[K]) => void
  ): DlgRef {
    // push a sentinel history entry so system-back closes this dialog
    history.pushState({ tag: 'soms-dlg' }, '')
    const ref: DlgRef = { id: this.nextDlgId++ }
    const entry: DlgEntry = {
      id: ref.id,
      info: { component: componentDict[popupType], inputs: inputs as Record<string, unknown> | undefined },
      onResult: onResult as ((result: unknown) => void) | undefined
    }
    this.dlgStack.push(entry)
    this.dlgList.update(list => list.concat([entry.info]))
    return ref
  }

  /**
   * Close the topmost dialog (a dialog closing itself). State updates synchronously; the sentinel history
   * entry is reconciled via one suppressed history.back so the popstate it fires is not mistaken for a
   * system-back. `result` is delivered to the opener's onResult. A genuine system-back reaches the same
   * close path via {@link onPopStateEvent}, delivering undefined.
   */
  closeDlg(result?: unknown): void {
    const top = this.dlgStack.pop()
    if (!top) return
    this.dlgList.update(list => list.slice(0, -1))
    top.onResult?.(result)
    this.reconcileBack(1)
  }

  /**
   * Close a specific dialog (by ref) together with every dialog stacked above it — its nested descendants.
   * For events that invalidate a whole scope: e.g. the chat a profile/info popup hangs off of is deleted, so
   * the children (scoped to that chat) must close with it; or an external SSE removal drops the thread while
   * its chat popup is open. Unlike {@link closeDlg} (top-only), this works regardless of what currently sits
   * on top. `result` is delivered to the target dialog's onResult; descendants close with undefined.
   */
  closeDialogAndAbove(ref: DlgRef, result?: unknown): void {
    const idx = this.dlgStack.findIndex(e => e.id === ref.id)
    if (idx === -1) return // already closed
    const removed = this.dlgStack.splice(idx) // target (idx) + everything above it
    this.dlgList.update(list => list.slice(0, idx))
    // deliver top-down so descendants finalize before the target; only the target receives `result`
    for (let i = removed.length - 1; i >= 0; i--) {
      removed[i].onResult?.(i === 0 ? result : undefined)
    }
    this.reconcileBack(removed.length)
  }

  /** Consume `delta` sentinel history entries we created, suppressing the popstate they fire. */
  private reconcileBack(delta: number): void {
    if (delta <= 0) return
    this.selfBackPending++
    if (delta === 1) history.back()
    else history.go(-delta)
  }

  onPopStateEvent(): void {
    // a popstate from our own programmatic close — state already updated, nothing to do
    if (this.selfBackPending > 0) { this.selfBackPending--; return }
    // genuine system-back: close the topmost dialog the same way closeDlg does (result undefined)
    const top = this.dlgStack.pop()
    if (!top) return // nothing open → let the browser/router handle the back
    this.dlgList.update(list => list.slice(0, -1))
    top.onResult?.(undefined)
  }

  go(delta: number) {
    history.go(delta)
  }
}
