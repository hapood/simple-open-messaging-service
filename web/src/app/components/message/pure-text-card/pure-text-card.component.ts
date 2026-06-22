import { Component, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { DisplayMsg } from '../../message-thread/model';

@Component({
    selector: 'app-pure-text-card',
    imports: [NgClass],
    templateUrl: './pure-text-card.component.html',
    styleUrl: './pure-text-card.component.scss'
})
export class PureTextCardComponent {
  data = input<DisplayMsg>()
  lines = signal<string[]>([])
  isSelf = signal(false)
  
  ngOnInit() {
    const data = this.data()!
    this.isSelf.set(data.isSelf)
    this.lines.set(data.content.split('\n'))
  }
}
