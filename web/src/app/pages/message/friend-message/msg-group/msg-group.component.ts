import { Component, computed, input } from '@angular/core';
import { NgClass } from '@angular/common';
import { Message } from '../../../../common/services/Interfaces';
import { UserProfile, displayMsg } from './modal'
@Component({
  selector: 'app-msg-group',
  standalone: true,
  imports: [NgClass],
  templateUrl: './msg-group.component.html',
  styleUrl: './msg-group.component.scss'
})
export class MsgGroupComponent {
  readonly list = input<Message[]>([])
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
}
