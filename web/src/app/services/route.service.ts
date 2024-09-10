import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { PopStateEvent } from '@angular/common'
import { delay, EMPTY, of, tap } from 'rxjs';

export enum RoutePage {
  HOME, AUTH_LOGIN, AUTH_REGISTER
}

interface AppPopState {
  type: RouteStateType,
  seq: number,
}

enum RouteStateType {
  NAV, STATE
}
@Injectable({
  providedIn: 'root',
})
export class RouteService {
  private _stateList!: { type: RouteStateType, data?: any }[]
  private _lastState: AppPopState | undefined

  constructor(private router: Router) {
    this._stateList = [{ type: RouteStateType.NAV, }]
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
      this._stateList.push({ type: RouteStateType.NAV, })
    } else {
      console.error(`no page to navigate [${page}]`)
    }
  }


  redirect(page: RoutePage, params?: any) {
    const commands = this.getPageRoute(page, params)
    if (commands) {
      const sList = this._stateList
      const state: AppPopState = { type: RouteStateType.NAV, seq: sList.length - 1 }
      this.router.navigate(commands, { replaceUrl: true, state });
      sList[sList.length - 1] = ({ type: RouteStateType.NAV })
    } else {
      console.error(`no page to redirect [${page}]`)
    }
  }

  onPopStateEvent(event: PopStateEvent) {
    let state: AppPopState = event.state
    if (this._lastState !== undefined && state.seq < this._lastState.seq) {
      this._stateList.pop()
    } else {
      this._stateList.push({ type: state.type })
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

  popupModalDlg() {
    history.pushState({ seq: this._stateList.length }, '')
    this._stateList.push({ type: RouteStateType.STATE, })
  }

  go(delta: number) {
    history.go(delta)
  }
}