import { Component, signal } from '@angular/core';
import { PopupService, PopupType } from '../../services/popup.service';
import { MaterialModalComponent } from '../material-modal/material-modal.component';
import { LoginComponent } from '../login/login.component';
import { LoginPageComponent } from "../../pages/auth/login/login-page.component";
import { Subject } from 'rxjs';
import { ComponentEventSubject } from '../../../utils'
import { AuthService } from '../../services/auth.service';

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

  constructor(private popupService: PopupService, private authService: AuthService) {
    this.popupService.subject.subscribe({
      next: (cmd) => {
        console.log(111, cmd)
        if (cmd.isShow === true) {
          console.log(this.popupType() === PopupType.LOGIN)
          if (this.popupType() === PopupType.LOGIN) {
            cmd.subject?.complete()
            cmd.subject?.unsubscribe()
          } else {
            this.clearLastSubject()
            this.curSubject.set(cmd.subject)
            if (cmd.popupType === PopupType.LOGIN) {
              this.popupType.set(PopupType.LOGIN)
            }
          }
        } else {
          this.clearLastSubject();
          this.curSubject.set(undefined)
          this.popupType.set(undefined)
        }
      },
      complete: (() => {
        console.log('complete')
      })
    })
  }

  ngOnInit() {
    this.authService.setPopupService(this.popupService)
    this.authService.renewAccessToken()
  }

  clearLastSubject() {
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
