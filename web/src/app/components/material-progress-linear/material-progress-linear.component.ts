import { Component, input } from '@angular/core';

@Component({
  selector: 'app-material-progress-linear',
  standalone: true,
  imports: [],
  templateUrl: './material-progress-linear.component.html',
  styleUrl: './material-progress-linear.component.scss'
})
export class MaterialProgressLinearComponent {
  value = input<number>()
  max = input<number>()
}
