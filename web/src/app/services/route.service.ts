import { Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { PopStateEvent } from '@angular/common'
import { delay, EMPTY, of, tap } from 'rxjs';
import { FriendRequestsComponent } from '../components/friend-requests/friend-requests.component';
import { MessageThreadComponent } from '../components/message-thread/friend-message.component';
import { NewGroupComponent } from '../components/new-group/new-group.component';
export enum RoutePage {
  HOME, AUTH_LOGIN, AUTH_REGISTER
}

export enum PopupType { FRIEND_REQUESTS, MSG_THREAD, NEW_GROUP }

const componentDict = {
  [PopupType.FRIEND_REQUESTS]: FriendRequestsComponent,
  [PopupType.MSG_THREAD]: MessageThreadComponent,
  [PopupType.NEW_GROUP]: NewGroupComponent
}

export interface DlgInfo {
  component: any,
  inputs?: any | undefined
}

interface Command {
  caller: string,
  popupType: PopupType,
  inputs?: any
}

interface AppPopState {
  type: RouteStateType,
  seq: number,
}

enum RouteStateType {
  NAV, DIALOG
}
@Injectable({
  providedIn: 'root',
})
export class RouteService {
  private _stateList!: AppPopState[]
  private _lastState: AppPopState | undefined
  dlgList = signal<DlgInfo[]>([])

  constructor(private router: Router) {
    this._stateList = [{ type: RouteStateType.NAV, seq: 0 }]
    window.addEventListener('popstate', (event) => this.onPopStateEvent(event))
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
      const state: AppPopState = { type: RouteStateType.NAV, seq: this._stateList.length }
      this.router.navigate(commands, { state });
      this._stateList.push(state)
    } else {
      console.error(`no page to navigate [${page}]`)
    }
  }

  popupDlg(cmd: Command) {
    const state: AppPopState = { type: RouteStateType.DIALOG, seq: this._stateList.length }
    history.pushState(state, '')
    this._stateList.push(state)
    const dlgList = this.dlgList
    dlgList.set(dlgList().concat([{ component: componentDict[cmd.popupType], inputs: cmd.inputs }]))
    this._lastState = state
  }

  redirect(page: RoutePage, params?: any) {
    const commands = this.getPageRoute(page, params)
    if (commands) {
      const sList = this._stateList
      const state: AppPopState = { type: RouteStateType.NAV, seq: sList.length - 1 }
      this.router.navigate(commands, { replaceUrl: true, state });
      sList[sList.length - 1] = state
      this._lastState = state
    } else {
      console.error(`no page to redirect [${page}]`)
    }
  }

  onPopStateEvent(event: PopStateEvent) {
    const state: AppPopState = event.state
    let curSeq = state.seq
    if (curSeq === undefined) { } {
      curSeq = 0
    }
    if (curSeq <= this._lastState!.seq) {
      const info = this._stateList.pop()
      if (info!.type === RouteStateType.DIALOG) {
        const dlgList = this.dlgList()
        this.dlgList.set(dlgList.slice(0, dlgList.length - 1))
      }
      this._lastState = info
    } else if (curSeq > this._lastState!.seq) {
      this._stateList.push(state)
      this._lastState = state
    } else {
      console.error('onPopStateEvent error, never should come here')
    }
  }

  clearHistoryThen() {
    return of(EMPTY).pipe(tap(() => {
      let step = 1 - this._stateList.length
      if (step < 0) {
        history.go(step)
      }
    }), delay(10))
  }

  hasPrevRoute() {
    return this._stateList.length > 1
  }

  go(delta: number) {
    history.go(delta)
  }
}