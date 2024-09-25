import {
  Component, computed, input, Output,
  EventEmitter, viewChild,
  ElementRef
} from '@angular/core';
import { NgClass } from '@angular/common';
import { MsgGroupStatus, DisplayMsg } from '../../message-thread/model'
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { MsgCardComponent } from '../msg-card/msg-card.component';

@Component({
  selector: 'app-msg-group',
  standalone: true,
  imports: [NgClass, UserAvatarComponent, MsgCardComponent],
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
    const elm = this.groupWrapper()!.nativeElement;
    const latestheight = elm.offsetHeight
    this.onHeightChange.emit({ index: this.index(), height: latestheight })
  }

  ngAfterViewInit() {
    const elm = this.groupWrapper()!.nativeElement;
    this.groupObserver = new ResizeObserver(entries => {
      this.checkHeightChange()
    })
    this.checkHeightChange()
    this.groupObserver.observe(elm);
  }

}
