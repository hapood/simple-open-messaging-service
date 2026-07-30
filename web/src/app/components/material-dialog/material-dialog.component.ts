import { Component, input } from '@angular/core';
import { NgClass } from '@angular/common';

@Component({
    selector: 'app-material-dialog',
    imports: [NgClass],
    templateUrl: './material-dialog.component.html',
    styleUrl: './material-dialog.component.scss'
})
export class MaterialDialogComponent {
  isShow = input(false)
  /** Skip the backdrop's close fade for surfaces that themselves close without a leave animation. */
  instantHide = input(false)
}
