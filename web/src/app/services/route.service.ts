import { Injectable } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { PopStateEvent } from '@angular/common'
export enum RoutePage {
  HOME, AUTH_LOGIN, AUTH_REGISTER
}

enum RouteStateType {
  NAV, STATE
}
@Injectable({
  providedIn: 'root',
})
export class RouteService {
  private _stateList!: { type: RouteStateType, data?: any }[]
  constructor(private route: ActivatedRoute, private router: Router) {
    this._stateList = [{ type: RouteStateType.NAV, }]
    window.addEventListener('PopStateEvent', (event) => this.onPopStateEvent(event))
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
      this.router.navigate(commands);
      this._stateList.push({ type: RouteStateType.NAV, })
    } else {
      console.error(`no page to navigate [${page}]`)
    }
  }


  redirect(page: RoutePage, params?: any) {
    const commands = this.getPageRoute(page, params)
    if (commands) {
      const sList = this._stateList
      this.router.navigate(commands, { replaceUrl: true });
      sList[sList.length - 1] = ({ type: RouteStateType.NAV })
    } else {
      console.error(`no page to redirect [${page}]`)
    }
  }

  onPopStateEvent(event: PopStateEvent) {
    this._stateList.pop()
  }

  clearHistory() {
    let step = 1 - this._stateList.length
    if (step < 0) {
      history.go(step)
    }
  }

  hasPrevRoute() {
    return this._stateList.length > 1
  }
  popupModalDlg(id: string) {
    history.pushState({ id }, '')
  }
}