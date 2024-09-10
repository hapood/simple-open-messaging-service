import { Component, EventEmitter, Output, input } from '@angular/core';

@Component({
  selector: 'app-material-menu-button',
  standalone: true,
  imports: [],
  templateUrl: './material-menu-button.component.html',
  styleUrl: './material-menu-button.component.scss'
})
export class MaterialMenuButtonComponent {
  @Output() click = new EventEmitter();
  disabled = input(false)

  onClick(event: MouseEvent) {
    this.click.emit(event)
  }
}
