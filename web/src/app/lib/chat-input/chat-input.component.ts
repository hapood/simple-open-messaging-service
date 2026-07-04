import {
  Component,
  ChangeDetectionStrategy,
  ViewEncapsulation,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ChatEditorComponent, type ChatMember } from '../../components/chat-editor/chat-editor.component';
import { PreventFocusStealDirective } from '../../directives/prevent-focus-steal.directive';
import { EmojiKeyboardService } from './emoji-keyboard.service';
import { EMOJI_CATEGORIES, EMOJIS_FLAT } from './emoji-data';

/**
 * A structured send intent emitted by {@link ChatInputComponent}. One discriminated union (rather than three
 * separate outputs) so the parent subscribes once and chronological order is preserved across rapid sends,
 * and so the parent's switch is exhaustive (TS forces handling every kind). The component never dispatches —
 * it only reports what the user wants to send; the host owns the optimistic-insert + HTTP/reconcile logic.
 */
export type ChatSendIntent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; files: FileList }
  | { kind: 'file'; files: FileList };

/**
 * Reusable chat composer (WhatsApp-style capsule + round send key), shared by the chatbox playground and the
 * production message thread. Extracted verbatim from the playground's input chrome (see the
 * `chatbox-playground-improvements` memory) and decoupled from dispatch:
 *
 *  - Owns presentation ONLY: the Tiptap editor, the emoji panel + click-to-close backdrop, the image/file
 *    pickers, the send button (paper-plane when there is draft text, camera when empty), auto-grow height
 *    measurement, and `appPreventFocusSteal` on every icon (mobile keyboard avoidance — see the
 *    `input-bar-icon-no-focus-steal` memory).
 *  - Emits {@link ChatSendIntent} on send; the host does the rest. Emits {@link heightChange} so a host that
 *    pins its viewport above the bar (the playground) can track the auto-grown height; a flex-layout host
 *    (production) may ignore it.
 *
 * Plain-text payload: the editor is rich for composition UX, but the text send serializes to plain text
 * (`editor.getText()`) — no HTML is stored. `members` drives the @mention suggestion popup (pass `[]` for
 * 1-on-1 where mentions are meaningless; a group host passes its member roster).
 *
 * `ViewEncapsulation.None` + the `ci-` prefix (mirrors the playground's global `pg-` pattern): the styles are
 * global, loaded once `<app-chat-input>` renders in either host.
 */
@Component({
  selector: 'app-chat-input',
  imports: [ChatEditorComponent, PreventFocusStealDirective],
  templateUrl: './chat-input.component.html',
  styleUrl: './chat-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class ChatInputComponent {
  /** @mention candidates (playground: mock; production group: member roster; production 1-on-1: []). Read into
   *  the editor; updates do NOT recreate the editor. */
  readonly members = input<ChatMember[]>([]);
  /** Fine-pointer input modality (physical keyboard present), width-independent. true → Enter sends;
   *  false (touch/soft keyboard) → Enter inserts a newline. Bind to {@link LayoutService.hasFinePointer}. */
  readonly hasFinePointer = input(true);
  readonly placeholder = input('');
  /** Disable the send key + ignore Enter while a send/upload is in flight (parent-driven). */
  readonly sending = input(false);
  /** Live soft-keyboard occlusion height (from the host's KbdOffsetDirective.occlusion). The swap freezes
   *  this at toggle time to size the panel that replaces the keyboard region. */
  readonly keyboardHeight = input(0);

  /** Structured send intent — the host switches on `kind`. */
  readonly send = output<ChatSendIntent>();
  /** The input bar's measured height (auto-grows with the editor); the host may bind its viewport bottom to it. */
  readonly heightChange = output<number>();

  /** Swap state machine (Android Chromium only; inert on iOS/desktop, which use the popup fallback below). */
  readonly emojiKbd = inject(EmojiKeyboardService);

  private readonly editor = viewChild(ChatEditorComponent);
  private readonly inputBar = viewChild<ElementRef<HTMLFormElement>>('inputBar');
  private readonly attachInput = viewChild<ElementRef<HTMLInputElement>>('attachInput');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  /** The editor's current inline HTML — used only for the send-button enabled state (empty editor ⇒ ''). The
   *  actual text payload is read via `editor.getText()` at send time. */
  readonly draftHtml = signal('');
  /** Popup-only open flag (the legacy fallback path — iOS Safari, Firefox, desktop). The Android swap uses
   *  {@link emojiKbd} instead, so this stays false wherever the swap is supported. */
  readonly emojiOpen = signal(false);

  /** Categorized dataset (swap panel renders tabs; popup fallback renders {@link emojisFlat}). */
  readonly categories = EMOJI_CATEGORIES;
  readonly emojisFlat = EMOJIS_FLAT;
  /** Active swap-panel category id (defaults to the first). */
  readonly activeCategory = signal(EMOJI_CATEGORIES[0]?.id ?? '');
  /** Glyphs of the active category (swap panel grid). */
  readonly activeEmojis = computed(
    () => EMOJI_CATEGORIES.find((c) => c.id === this.activeCategory())?.icons ?? [],
  );

  // Editor content changed: track draft (send-button state) + re-measure the bar (auto-grow ⇒ heightChange).
  onHtml(h: string): void {
    this.draftHtml.set(h);
    this.measureBar();
  }

  toggleEmoji(): void {
    if (this.emojiKbd.supported()) this.emojiKbd.toggle(this.keyboardHeight());
    else this.emojiOpen.update((v) => !v);
  }
  closeEmoji(): void {
    this.emojiKbd.close();
    this.emojiOpen.set(false);
  }
  /** ABC chip: close the swap panel and re-focus the editor — the editor's manual-policy focus→show handler
   *  brings the native keyboard back. Caret is intact (the editor never blurred). */
  closeEmojiAndFocus(): void {
    this.emojiKbd.close();
    this.editor()?.focus();
  }
  /** Insert the emoji at the editor caret (the editor manages caret restoration), then refocus. */
  insertEmoji(e: string): void {
    this.editor()?.insertText(e);
    this.editor()?.focus();
  }

  /** Send key: draft present → emit a text intent (plain text) + clear; empty → open the image picker. */
  onSendClick(): void {
    if (this.sending()) return;
    if (this.draftHtml()) this.sendText();
    else this.onAttachClick();
  }

  /** Desktop Enter (the editor's `send` output): same as the text branch of the send key. */
  onEditorSend(): void {
    if (this.sending()) return;
    this.sendText();
  }

  private sendText(): void {
    const editor = this.editor();
    if (!editor) return;
    const text = editor.getText().trim();
    if (!text) return;
    editor.clear();
    this.draftHtml.set('');
    this.measureBar();
    this.send.emit({ kind: 'text', text });
  }

  onAttachClick(): void {
    this.attachInput()?.nativeElement.click();
  }
  onAttachChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) this.send.emit({ kind: 'image', files: input.files });
    input.value = ''; // reset so the same file can be picked again
  }

  onFileClick(): void {
    this.fileInput()?.nativeElement.click();
  }
  onFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) this.send.emit({ kind: 'file', files: input.files });
    input.value = '';
  }

  /** Measure the bar's border-box height on the next frame and emit (the editor's auto-grow changes it). The
   *  playground binds its viewport bottom to this; production's flex layout ignores it. */
  private measureBar(): void {
    requestAnimationFrame(() => {
      const bar = this.inputBar()?.nativeElement;
      if (bar) this.heightChange.emit(bar.offsetHeight);
    });
  }
}
