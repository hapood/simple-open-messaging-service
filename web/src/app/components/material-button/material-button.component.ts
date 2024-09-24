import { Component, input } from '@angular/core';
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
  styleType = input(MaterialButtonType.CONTAINTED)
  disabled = input(false)
}
