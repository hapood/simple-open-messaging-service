import {
  Component, computed, input, Output,
  EventEmitter, viewChild, effect,
  ElementRef
} from '@angular/core';
import { NgClass } from '@angular/common';
import { Message } from '../../../../common/services/Interfaces';
import { UserProfile, displayMsg } from './modal'
import { MsgGroupStatus } from '../modal'
@Component({
  selector: 'app-msg-group',
  standalone: true,
  imports: [NgClass],
  templateUrl: './msg-group.component.html',
  styleUrl: './msg-group.component.scss'
})
export class MsgGroupComponent {
  @Output() onStatusChange = new EventEmitter<{ index: number, status: MsgGroupStatus, height: number }>();
  readonly groupWrapper = viewChild<ElementRef<HTMLDivElement>>('groupWrapper');

  readonly index = input<number>(-1)
  readonly list = input<Message[]>([])
  readonly status = input<MsgGroupStatus>(MsgGroupStatus.CALCING)
  readonly profileRecord = input<Record<string, UserProfile>>({})
  readonly displayList = computed(() => {
    const profileDict = this.profileRecord();
    const list = this.list()
    return list.map(item => {
      return {
        ...item,
        creatorName: profileDict[item.creator]?.uniqName,
        isSelf: profileDict[item.creator]?.isSelf ?? false,
      } as displayMsg
    })
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
    this.groupObserver = new ResizeObserver(entries => {
      const height = entries[0].contentRect.width;
      this.onStatusChange.emit({ index: this.index(), status: MsgGroupStatus.PREPARED, height })
    })
    this.groupObserver.observe((this.groupWrapper() as any).nativeElement);
  }

}
