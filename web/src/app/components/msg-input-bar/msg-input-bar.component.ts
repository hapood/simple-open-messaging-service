import { Component, input, viewChild, ElementRef, Output, EventEmitter, signal } from '@angular/core';
import { IconComponent } from "../icon/icon.component";
import { AppIconType } from '../icon/modal';
import { tap } from 'rxjs';
import { MsgService } from '../../services/message.service'

@Component({
  selector: 'app-msg-input-bar',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './msg-input-bar.component.html',
  styleUrl: './msg-input-bar.component.scss'
})
export class MsgInputBarComponent {

  readonly threadId = input<number>()
  @Output() onAfterSent = new EventEmitter();
  readonly userInput = viewChild<ElementRef<HTMLInputElement>>('userInput');
  readonly AppIconType = AppIconType
  readonly isEditing = signal(false)

  onUserInput(event: Event) {
    console.log((event as InputEvent).data)
  }

  constructor(private msgService: MsgService) {
  }

  clearTextInput() {
    const elm = this.userInput()!.nativeElement
    elm.innerHTML = ''
  }

  getInputText() {
    const elm = this.userInput()!.nativeElement
    return elm.innerText;
  }

  onClickIptWrp(event: Event) {
    event.stopPropagation()
    console.log(event)
    const elm = this.userInput()!.nativeElement
    elm.focus()
  }

  onLeftBtnClk(event: Event) {
    event.stopPropagation()
  }

  checkSend(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      this.send()
    }
  }

  send(): void {
    let threadId = this.threadId()
    if (threadId) {
      const content = this.getInputText()
      console.info(`send content: ${content}`)
      if (content) {
        this.msgService.sendMessage({ threadId, content }).pipe(
          tap(() => {
            this.clearTextInput()
          }))
          .subscribe(
            {
              next: (res) => {
                this.onAfterSent.emit()
              },
              error: (error) => {
                console.error(error)
              }
            })
      }
    }
  }
}
