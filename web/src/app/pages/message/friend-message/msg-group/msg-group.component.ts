import {
  Component, computed, input, Output,
  EventEmitter, viewChild, effect,
  ElementRef
} from '@angular/core';
import { NgClass } from '@angular/common';
import { Message } from '../../../../common/services/Interfaces';
import { UserProfile, displayMsg } from './modal'
import { MsgGroupStatus } from '../modal'
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
  @Output() onStatusChange = new EventEmitter<{ index: number, status: MsgGroupStatus, height: number }>();
  readonly groupWrapper = viewChild<ElementRef<HTMLDivElement>>('groupWrapper');

  readonly UserAvatarType = UserAvatarType
  readonly index = input<number>(-1)
  readonly list = input<Message[]>([])
  readonly status = input<MsgGroupStatus>(MsgGroupStatus.CALCING)
  readonly profileRecord = input<Record<string, UserProfile>>({})
  readonly displayList = computed(() => {
    const profileDict = this.profileRecord();
    const list = this.list()
    console.log(list)
    return list.map(item => {
      return {
        ...item,
        lines: item.content.split('\n'),
        creatorName: profileDict[item.creator]?.uniqName,
        isSelf: profileDict[item.creator]?.isSelf ?? false,
      } as displayMsg
    })
  })
  readonly groupWrapperClass = computed(() => {
    let className!: string
    switch (this.status()) {
      case MsgGroupStatus.CALCING:
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

  private groupObserver!: ResizeObserver;

  constructor() {
    effect(() => {
      const status = this.status()
      if (status === MsgGroupStatus.PREPARED) {

      }
    })
  }

  ngAfterViewInit() {
    const elm = (this.groupWrapper() as any).nativeElement as HTMLDivElement;
    // this.groupObserver = new ResizeObserver(entries => {
    //   this.onStatusChange.emit({ index: this.index(), status: MsgGroupStatus.PREPARED, height: elm.offsetHeight })
    // })
    const height = elm.offsetHeight
    if (height > 0) {
      this.onStatusChange.emit({ index: this.index(), status: MsgGroupStatus.PREPARED, height })
    }
    console.log(this.index(), height)

    // this.groupObserver.observe(elm);
  }

}
