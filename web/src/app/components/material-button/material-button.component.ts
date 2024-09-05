import { Component, EventEmitter, Output, input } from '@angular/core';
import { NgClass } from '@angular/common';

export enum MaterialButtonType {
  CONTAINTED, OUTLINED, TEXT
}

@Component({
  selector: 'app-material-button',
  standalone: true,
  imports: [NgClass],
  templateUrl: './material-button.component.html',
  styleUrl: './material-button.component.scss'
})

export class MaterialButtonComponent {
  MaterialButtonType = MaterialButtonType
  type = input(MaterialButtonType.CONTAINTED)
  @Output() click = new EventEmitter();

  onClick(event: MouseEvent) {
    this.click.emit(event)
  }

}
