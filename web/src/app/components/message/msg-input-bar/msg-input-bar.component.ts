import { Component, input, viewChild, ElementRef, Output, EventEmitter, signal } from '@angular/core';
import { IconComponent } from "../../icon/icon.component";
import { AppIconType } from '../../icon/model';
import { tap } from 'rxjs';
import { MsgService } from '../../../services/message.service'

@Component({
    selector: 'app-msg-input-bar',
    imports: [IconComponent],
    templateUrl: './msg-input-bar.component.html',
    styleUrl: './msg-input-bar.component.scss'
})
export class MsgInputBarComponent {

  readonly userThreadId = input<number>()
  @Output() onAfterSent = new EventEmitter();
  readonly userInput = viewChild<ElementRef<HTMLInputElement>>('userInput');
  readonly AppIconType = AppIconType
  readonly isTyping = signal(false)
  readonly isFocus = signal(false)
  readonly isEmjPnlShow = signal(false)

  emojiList = ['\u{1F601}', '\u{1F602}', '\u{1F603}', '\u{1F604}', '\u{1F605}', '\u{1F606}',
    '\u{1F609}', '\u{1F60A}', '\u{1F60B}', '\u{1F60C}', '\u{1F60D}', '\u{1F60F}', '\u{1F612}',
    '\u{1F613}', '\u{1F614}', '\u{1F616}', '\u{1F618}', '\u{1F61A}', '\u{1F61C}', '\u{1F61D}',
    '\u{1F61E}', '\u{1F620}', '\u{1F621}', '\u{1F622}', '\u{1F623}', '\u{1F624}', '\u{1F625}',
    '\u{1F628}', '\u{1F629}', '\u{1F62A}', '\u{1F62B}', '\u{1F62D}', '\u{1F630}', '\u{1F631}',
    '\u{1F632}', '\u{1F633}', '\u{1F635}', '\u{1F637}', '\u{1F638}', '\u{1F639}', '\u{1F63A}',
    '\u{1F63B}', '\u{1F63C}', '\u{1F63D}', '\u{1F63E}', '\u{1F63F}', '\u{1F640}', '\u{1F645}',
    '\u{1F646}', '\u{1F647}', '\u{1F648}', '\u{1F649}', '\u{1F64A}', '\u{1F64B}', '\u{1F64C}',
    '\u{1F64D}', '\u{1F64E}', '\u{1F64F}',]

  onUserInput(event: Event) {
    const content = this.getInputText()
    if (content.length > 0) {
      this.isTyping.set(true)
    }
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

  checkSend(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      this.send()
    }
  }

  switchEmjPnl(event: Event) {
    event.preventDefault()
    console.log(this.isEmjPnlShow())
    this.isEmjPnlShow.set(!this.isEmjPnlShow())
  }

  insertEmoji(char: string) {
    const elm = this.userInput()!.nativeElement
    var range = document.createRange()
    var sel = window.getSelection()
  }

  send(): void {
    let userThreadId = this.userThreadId()
    if (userThreadId) {
      const content = this.getInputText()
      console.info(`send content: ${content}`)
      if (content) {
        this.msgService.sendMessage({ userThreadId, content }).pipe(
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
