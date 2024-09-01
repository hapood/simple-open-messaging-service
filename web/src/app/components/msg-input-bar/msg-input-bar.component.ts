import { Component, input, viewChild, ElementRef, Output, EventEmitter } from '@angular/core';
import { IconComponent } from "../icon/icon.component";
import { AppIconType } from '../icon/modal';
import { tap } from 'rxjs';
import { MsgService } from '../../common/services/message.service'

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
  onUserInput(event: Event) {
    console.log((event as InputEvent).data)
  }

  constructor(private msgService: MsgService) {
  }
  clearTextInput() {
    const elm = (this.userInput() as any).nativeElement as HTMLDivElement
    elm.innerHTML = ''
  }

  getInputText() {
    const elm = (this.userInput() as any).nativeElement as HTMLDivElement
    return elm.innerText;
  }

  onClickIptWrp(event:Event) {
    event.stopPropagation()
    console.log(event)
    const elm = (this.userInput() as any).nativeElement as HTMLDivElement
    elm.focus()
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
