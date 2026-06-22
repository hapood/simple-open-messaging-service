import { Component, input } from '@angular/core';
import { NgStyle } from '@angular/common';
@Component({
    selector: 'app-material-menu',
    imports: [NgStyle],
    templateUrl: './material-menu.component.html',
    styleUrl: './material-menu.component.scss'
})
export class MaterialMenuComponent {
  offset = input({ top: '0px', left: '0px' })
  width = input('120px')
  isShow = input(false)
}
