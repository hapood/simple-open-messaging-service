import { computed, inject, Injectable, Type } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { AvatarEditorComponent } from '../components/avatar-editor/avatar-editor.component';
import { FriendRequestsComponent } from '../components/friend-requests/friend-requests.component';
import { NewGroupComponent } from '../components/new-group/new-group.component';
import { FolderEditorComponent } from '../components/folder-editor/folder-editor.component';
import { EditProfileComponent } from '../components/edit-profile/edit-profile.component';
import { SessionsComponent } from '../components/sessions/sessions.component';
import { ConfirmDialogComponent } from '../components/confirm-dialog/confirm-dialog.component';
import { SettingsDialogComponent } from '../components/settings/settings-dialog.component';
import { AppIconType } from '../components/icon/model';
import { NavStateMachineService } from './nav-state.service';

export enum RoutePage {
  HOME, AUTH_LOGIN, AUTH_REGISTER
}

/**
 * Transient dialogs only. The dialogs are entries on {@link NavStateMachineService.paneStack} (kind
 * `'dialog'`); this service is the typed façade over them (component resolution, input/result contracts,
 * the {@link DlgRef} handle). `dlgList` is a computed view of the dialog entries that RootPopup renders.
 * The auth-page `navigate`/`redirect` helpers stay (those are page-level router routes, not app-nav).
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
  /** Render the desktop centered card wider than 480px (two-column Settings dialog). */
  wide?: boolean
}

/**
 * Opaque handle to an open dialog, returned by {@link RouteService.popupDlg}. Pass it to
 * {@link RouteService.closeDialogAndAbove} to close that specific dialog (and its nested descendants)
 * from outside the dialog itself — e.g. when an event invalidates the conversation it was opened from.
 */
export interface DlgRef {
  /** Matches the nav state machine pane entry id. */
  readonly id: number
}

@Injectable({
  providedIn: 'root',
})
export class RouteService {
  private readonly nav = inject(NavStateMachineService);

  constructor(private router: Router) {}

  /** The dialog stack as {@link DlgInfo}s — RootPopup renders this via @for + *ngComponentOutlet. Derived
   *  from the nav state machine's dialog pane entries. */
  readonly dlgList = computed<DlgInfo[]>(() =>
    this.nav.dialogs().map((p) => ({
      component: p.component as Type<unknown>,
      inputs: p.inputs,
      wide: p.wide,
    })),
  );

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

  /** Push a dialog onto the nav pane stack; returns a {@link DlgRef} for targeted close. The dialog's
   *  `onResult` is delivered the close result (or `undefined` on cancel / back / scope-clear). */
  popupDlg<K extends PopupType>(
    popupType: K,
    inputs?: PopupInput[K],
    onResult?: (result: PopupResult[K]) => void
  ): DlgRef {
    const id = this.nav.pushPane({
      kind: 'dialog',
      component: componentDict[popupType],
      inputs: inputs as Record<string, unknown> | undefined,
      onResult: onResult as ((result: unknown) => void) | undefined,
    })
    return { id }
  }

  /**
   * Open Settings as a wide two-column dialog (desktop/tablet). Mobile does NOT use this — it opens the
   * aside surface ({@link NavStateMachineService.openAside}) instead; the branch lives in the entry points
   * (icon-rail / nav-drawer). Pushed as a `wide` dialog pane so RootPopup renders a wider centered card on
   * desktop (the default 480px is too narrow for two columns) and a full-screen sheet on tablet. Back /
   * hardware-back peels it in one step (no drill-in layers in flat mode).
   */
  openSettingsDialog(): DlgRef {
    const id = this.nav.pushPane({ kind: 'dialog', component: SettingsDialogComponent, wide: true });
    return { id };
  }

  /**
   * Close the topmost dialog (a dialog closing itself), delivering `result`. Finds the topmost `dialog`
   * entry on the pane stack (search/overlay panes, if any, sit above dialogs and are left alone).
   */
  closeDlg(result?: unknown): void {
    const stack = this.nav.paneStack()
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].kind === 'dialog') {
        this.nav.closePane(stack[i].id, result)
        return
      }
    }
  }

  /**
   * Close a specific dialog (by ref) together with every pane stacked above it — its nested descendants.
   * For events that invalidate a whole scope: e.g. the chat a profile/info popup hangs off of is deleted, so
   *  the children (scoped to that chat) must close with it; or an external SSE removal drops the thread while
   *  its chat popup is open. `result` is delivered to the target dialog's onResult; descendants close with
   *  undefined.
   */
  closeDialogAndAbove(ref: DlgRef, result?: unknown): void {
    this.nav.closePane(ref.id, result)
  }
}
