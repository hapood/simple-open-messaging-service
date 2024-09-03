import {
  Component, computed, input, Output,
  EventEmitter, viewChild, effect,
  ElementRef
} from '@angular/core';
import { NgClass } from '@angular/common';
import { MsgGroupStatus, DisplayMsg } from '../modal'
import { UserAvatarComponent } from '../../../../components/user-avatar/user-avatar.component';
import { UserAvatarType } from '../../../../components/user-avatar/modal';

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
  readonly nextHeight = input<MsgGroupStatus>(0)
  MsgGroupStatus = MsgGroupStatus
  private groupObserver!: ResizeObserver;
  private latestheight = 0

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
    effect(() => {
      const status = this.nextStatus()
      if (status === MsgGroupStatus.PREPARED) {

      }
    })
  }

  checkHeightChange() {
    const elm = (this.groupWrapper() as any).nativeElement as HTMLDivElement;
    const latestheight = elm.offsetHeight
    if (latestheight !== this.nextHeight()) {
      console.info(`group index [${this.index()}] height changed from \
      [${this.latestheight}] to [${latestheight}], id:[${this.list()[0].id}]`)
      this.onHeightChange.emit({ index: this.index(), height: latestheight })
      this.latestheight = latestheight
    }
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
