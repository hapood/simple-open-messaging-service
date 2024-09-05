import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ComponentEventSubject } from '../../utils'

export enum PopupType { LOGIN }

interface Command {
  isShow: boolean,
  popupType: PopupType | undefined,
  subject: Subject<ComponentEventSubject<any>>
}

@Injectable({
  providedIn: 'root'
})
export class PopupService {
  subject = new Subject<Command>()
  constructor() { }
}
