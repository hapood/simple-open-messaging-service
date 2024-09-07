import { Component, input, model, signal, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgClass } from '@angular/common';


@Component({
  selector: 'app-material-input',
  standalone: true,
  imports: [FormsModule, NgClass],
  templateUrl: './material-input.component.html',
  styleUrl: './material-input.component.scss'
})
export class MaterialInputComponent {
  text = model('')
  placeholder = input()
  required = input(false)
  pattern = input<string | RegExp>('')
  type = input<'text' | 'password'>('text')
  isFocus = signal(false)

  readonly userInput = viewChild<ElementRef<HTMLInputElement>>('userInput');

  onFocus() {
    this.isFocus.set(true)
  }

  onBlur() {
    this.isFocus.set(false)
  }

  focusInput(event: Event) {
    const elm = this.userInput()!.nativeElement
    elm.focus()
    // event.stopPropagation()
  }

  ngOnInit() {
    console.log(this.text(), this.text() === "")
  }
}
