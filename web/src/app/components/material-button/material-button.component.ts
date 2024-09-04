import { Component, EventEmitter, Output } from '@angular/core';

@Component({
  selector: 'app-material-button',
  standalone: true,
  imports: [],
  templateUrl: './material-button.component.html',
  styleUrl: './material-button.component.scss'
})
export class MaterialButtonComponent {

  @Output() click = new EventEmitter();

  onClick(event: MouseEvent) {
    this.click.emit(event)
  }

}
