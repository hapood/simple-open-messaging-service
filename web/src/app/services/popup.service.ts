import { Injectable, signal } from '@angular/core';
import { BehaviorSubject, Subject } from 'rxjs';
import { ComponentEventSubject } from '../../utils'

export enum PopupType { LOGIN }

interface Command {
  caller: string,
  isShow: boolean,
  popupType: PopupType | undefined,
  subject?: Subject<ComponentEventSubject<any>>
}

@Injectable({
  providedIn: 'root'
})
export class PopupService {
  private _popupType: PopupType | undefined
  subject = new BehaviorSubject<Command>({ caller: 'self-init', isShow: false, popupType: undefined })
  constructor() {
    console.log('init!!!!')
    this.subject.subscribe({
      next: (cmd) => {
        console.log('12',cmd)
        if (cmd.isShow === true) {
          this._popupType = cmd.popupType
        } else {
          this._popupType = undefined
        }
      }
    })
  }
  getCurrentPopupType() {
    return this._popupType
  }
}
