import { Component, input } from '@angular/core';
import { NgClass } from '@angular/common';

@Component({
  selector: 'app-material-modal',
  standalone: true,
  imports: [NgClass],
  templateUrl: './material-modal.component.html',
  styleUrl: './material-modal.component.scss'
})
export class MaterialModalComponent {
  
  isShow = input(false)
}
