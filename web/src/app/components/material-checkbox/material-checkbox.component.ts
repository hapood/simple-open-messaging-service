import { Component, model } from '@angular/core';

@Component({
    selector: 'app-material-checkbox',
    imports: [],
    templateUrl: './material-checkbox.component.html',
    styleUrl: './material-checkbox.component.scss'
})
export class MaterialCheckboxComponent {
  checked = model(false)
}
