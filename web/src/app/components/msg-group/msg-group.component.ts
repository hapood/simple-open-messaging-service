import {
  Component, computed, input, Output,
  EventEmitter, viewChild, effect,
  ElementRef
} from '@angular/core';
import { NgClass } from '@angular/common';
import { MsgGroupStatus, DisplayMsg } from '../message-thread/modal'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';

@Component({
  selector: 'app-msg-group',
  standalone: true,
  imports: [NgClass, UserAvatarComponent],
  templateUrl: './msg-group.component.html',
  styleUrl: './msg-group.component.scss'
})
export class MsgGroupComponent {
  @Output() onHeightChange = new EventEmitter<{ index: number, height: number }>();
  readonly groupWrapper = viewChild<ElementRef<HTMLDivElement>>('groupWrapper');

  readonly UserAvatarType = UserAvatarType
  readonly index = input<number>(-1)
  readonly list = input<DisplayMsg[]>([])
  readonly nextStatus = input<MsgGroupStatus>(MsgGroupStatus.GENERATING)
  MsgGroupStatus = MsgGroupStatus
  private groupObserver!: ResizeObserver;

  readonly groupWrapperClass = computed(() => {
    let className!: string
    switch (this.nextStatus()) {
      case MsgGroupStatus.RENDERING:
        className = "calc"
        break
      case MsgGroupStatus.PREPARED:
        className = "prepared"
        break
      case MsgGroupStatus.STABLE:
        className = "stable"
        break
      default:
        className = ""
    }
    return className
  })

  constructor() {
  }

  checkHeightChange() {
    const elm = (this.groupWrapper() as any).nativeElement as HTMLDivElement;
    const latestheight = elm.offsetHeight
    this.onHeightChange.emit({ index: this.index(), height: latestheight })
  }

  ngAfterViewInit() {
    const elm = (this.groupWrapper() as any).nativeElement as HTMLDivElement;
    this.groupObserver = new ResizeObserver(entries => {
      this.checkHeightChange()
    })
    this.checkHeightChange()
    this.groupObserver.observe(elm);
  }

}
