import { Injectable, signal, Type } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { FriendRequestsComponent } from '../components/friend-requests/friend-requests.component';
import { MessageThreadComponent } from '../components/message-thread/friend-message.component';
import { NewGroupComponent } from '../components/new-group/new-group.component';
import { GroupInfoComponent } from '../components/group-info/group-info.component';
import { FolderEditorComponent } from '../components/folder-editor/folder-editor.component';
import { EditProfileComponent } from '../components/edit-profile/edit-profile.component';
import { SessionsComponent } from '../components/sessions/sessions.component';
import { UserMessageThread } from './model';

export enum RoutePage {
  HOME, AUTH_LOGIN, AUTH_REGISTER
}

export enum PopupType { FRIEND_REQUESTS, MSG_THREAD, NEW_GROUP, GROUP_INFO, FOLDER_EDITOR, EDIT_PROFILE, SESSIONS }

const componentDict: Record<PopupType, Type<unknown>> = {
  [PopupType.FRIEND_REQUESTS]: FriendRequestsComponent,
  [PopupType.MSG_THREAD]: MessageThreadComponent,
  [PopupType.NEW_GROUP]: NewGroupComponent,
  [PopupType.GROUP_INFO]: GroupInfoComponent,
  [PopupType.FOLDER_EDITOR]: FolderEditorComponent,
  [PopupType.EDIT_PROFILE]: EditProfileComponent,
  [PopupType.SESSIONS]: SessionsComponent
}

// per-popup input contracts — what each dialog's input() fields accept
export interface PopupInput {
  [PopupType.FRIEND_REQUESTS]: { subject?: Subject<any> }
  [PopupType.MSG_THREAD]: { userThreadId: number, userMsgTrd: UserMessageThread, startMsgId?: string }
  [PopupType.NEW_GROUP]: undefined
  [PopupType.GROUP_INFO]: { userMsgTrd: UserMessageThread }
  [PopupType.FOLDER_EDITOR]: { folderId?: string }
  [PopupType.EDIT_PROFILE]: undefined
  [PopupType.SESSIONS]: undefined
}

// per-popup result contracts — what a dialog passes back to its opener via closeDlg()
export interface PopupResult {
  [PopupType.FRIEND_REQUESTS]: undefined
  [PopupType.MSG_THREAD]: undefined
  [PopupType.NEW_GROUP]: { groupId: number }
  [PopupType.GROUP_INFO]: undefined
  [PopupType.FOLDER_EDITOR]: boolean
  [PopupType.EDIT_PROFILE]: boolean
  [PopupType.SESSIONS]: undefined
}

export interface DlgInfo {
  component: Type<unknown>,
  inputs?: Record<string, unknown>
}

interface DlgEntry {
  info: DlgInfo
  onResult?: (result: unknown) => void
  result?: unknown
}

@Injectable({
  providedIn: 'root',
})
export class RouteService {
  private dlgStack: DlgEntry[] = []
  dlgList = signal<DlgInfo[]>([])

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
  ) {
    // push a sentinel history entry so back closes this dialog
    history.pushState({ tag: 'soms-dlg' }, '')
    const entry: DlgEntry = {
      info: { component: componentDict[popupType], inputs: inputs as Record<string, unknown> | undefined },
      onResult: onResult as ((result: unknown) => void) | undefined
    }
    this.dlgStack.push(entry)
    this.dlgList.update(list => list.concat([entry.info]))
  }

  // close the topmost dialog, optionally returning a result to its opener.
  // funnels through history.back() so system-back and button-back behave identically.
  closeDlg(result?: unknown) {
    const top = this.dlgStack[this.dlgStack.length - 1]
    if (top) {
      top.result = result
      history.back()
    }
  }

  onPopStateEvent() {
    // back while dialogs are open → close the topmost one and deliver its result
    if (this.dlgStack.length > 0) {
      const entry = this.dlgStack.pop()!
      if (entry.onResult) {
        entry.onResult(entry.result)
      }
      this.dlgList.update(list => list.slice(0, -1))
    }
  }

  go(delta: number) {
    history.go(delta)
  }
}
