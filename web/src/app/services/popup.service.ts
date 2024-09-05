import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ComponentEventSubject } from '../../utils'

export enum PopupType { LOGIN }

interface Command {
  isShow: boolean,
  popupType: PopupType | undefined,
  subject?: Subject<ComponentEventSubject<any>>
}

interface CbCommand {
  isShow: boolean,
  popupType: PopupType | undefined,
}

@Injectable({
  providedIn: 'root'
})
export class PopupService {
  private _popupType: PopupType | undefined

  subject = new Subject<Command>()
  cbSubject = new Subject<CbCommand>()
  constructor() {
    this.cbSubject.subscribe({
      next: (cmd) => {
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
