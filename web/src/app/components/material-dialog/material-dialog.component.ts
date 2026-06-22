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
}
