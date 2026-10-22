import { Directive, HostListener } from '@angular/core';

/**
 * Keep focus on the active editor/input when the host control is pressed.
 *
 * Background: a `<button>` inside the chat input bar (emoji / attach / file / send) receives focus on
 * mousedown — that focus move is the default action of mousedown. On mobile it blurs the Tiptap
 * composer (or textarea), which collapses the soft keyboard and drops the caret; tapping an individual
 * emoji glyph mid-typing has the same effect. The user expects these tool buttons to act on the editor
 * without ever defocusing it.
 *
 * Fix: cancel that default action with preventDefault. The subsequent `click` still fires, so the
 * button's (click) handler runs unchanged — only the focus move is skipped. This is the same technique
 * the @mention suggestion popup already relies on (it calls `e.preventDefault()` in its own mousedown
 * listener so the editor does not blur before the mention command runs — see chat-editor.component.ts).
 *
 * Keyboard accessibility is intact: Tab advances focus on keydown, not mousedown, so the control stays
 * reachable via the keyboard. Only the primary press (left mouse / touch synthesis, button === 0) is
 * intercepted; middle/right clicks keep their native behavior.
 */
@Directive({ selector: '[appPreventFocusSteal]' })
export class PreventFocusStealDirective {
  @HostListener('mousedown', ['$event'])
  onMousedown(event: MouseEvent): void {
    if (event.button === 0) event.preventDefault();
  }
}
