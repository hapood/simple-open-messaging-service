import { Component, signal } from '@angular/core';
import { PopupService, PopupType } from '../../services/popup.service';
import { MaterialModalComponent } from '../material-modal/material-modal.component';
import { LoginComponent } from '../login/login.component';
import { LoginPageComponent } from "../../pages/auth/login/login-page.component";
import { Subject } from 'rxjs';
import { ComponentEventSubject } from '../../../utils'

@Component({
  selector: 'app-root-popup',
  standalone: true,
  imports: [MaterialModalComponent, LoginComponent, LoginPageComponent],
  providers: [PopupService],
  templateUrl: './root-popup.component.html',
  styleUrl: './root-popup.component.scss'
})
export class RootPopupComponent {
  readonly PopupType = PopupType
  readonly popupType = signal<PopupType | undefined>(undefined)
  curSubject = signal<Subject<ComponentEventSubject<any>> | undefined>(undefined) //won't be undefined when template call it
  lastPopupType: PopupType | undefined

  constructor(private popupService: PopupService) {
    popupService.subject.subscribe({
      next: (cmd) => {
        if (cmd.isShow === true) {
          this.clearLastSubject()
          this.curSubject.set(cmd.subject)
          if (cmd.popupType === PopupType.LOGIN) {
            this.popupType.set(PopupType.LOGIN)
          }
        } else {
          this.clearLastSubject();
          this.curSubject.set(undefined)
        }
      }
    })
  }

  clearLastSubject() {
    this.popupService.cbSubject.next({ isShow: false, popupType: this.popupType() })
    const subj = this.curSubject()
    if (subj !== undefined) {
      subj.complete()
      subj.unsubscribe()
    }
  }

  ngOnDestroy() {
    this.clearLastSubject()
  }
}
