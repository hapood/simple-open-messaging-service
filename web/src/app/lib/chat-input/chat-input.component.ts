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
import { EMOJI_CATEGORIES } from './emoji-data';

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

/** A category/tab shown in the emoji panel (Recents is a synthetic tab when non-empty). */
interface EmojiTab {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly icons: readonly string[];
}

const RECENTS_KEY = 'soms.chat.emojiRecents';
const RECENTS_MAX = 32;

/** Load the persisted recents list (SSR/private-mode safe). */
function loadRecents(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Persist the recents list (best-effort; swallow quota / private-mode errors). */
function saveRecents(list: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
  } catch {
    /* quota exceeded or private mode — ignore */
  }
}

/**
 * Reusable chat composer (WhatsApp-style capsule + round send key), shared by the chatbox playground and the
 * production message thread.
 *
 *  - Owns presentation ONLY: the Tiptap editor, the emoji panel + click-to-close backdrop, the image/file
 *    pickers, the send button (paper-plane when there is draft text, camera when empty), auto-grow height
 *    measurement, and `appPreventFocusSteal` on every icon (mobile keyboard avoidance — see the
 *    `input-bar-icon-no-focus-steal` memory).
 *  - Emits {@link ChatSendIntent} on send; the host does the rest. Emits {@link heightChange} so a host that
 *    pins its viewport above the bar (the playground) can track the auto-grown height; a flex-layout host
 *    (production) may ignore it.
 *
 * Emoji panel: a WhatsApp/Telegram-style floating panel (category tabs + scrollable grid + a persisted
 * Recents tab). The native soft keyboard stays up on mobile — there is NO VirtualKeyboard swap. That API's
 * `hide()` is broken on Chrome Android (crbug.com/40912131, open since 2023); the swap path was abandoned in
 * favor of the popup-everywhere approach the major web chat clients use. See the `emoji-keyboard-vkb-swap`
 * memory.
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
  readonly placeholder = input('');
  /** Disable the send key + ignore Enter while a send/upload is in flight (parent-driven). */
  readonly sending = input(false);

  /** Structured send intent — the host switches on `kind`. */
  readonly send = output<ChatSendIntent>();
  /** The input bar's measured height (auto-grows with the editor); the host may bind its viewport bottom to it. */
  readonly heightChange = output<number>();

  private readonly editor = viewChild(ChatEditorComponent);
  private readonly inputBar = viewChild<ElementRef<HTMLFormElement>>('inputBar');
  private readonly attachInput = viewChild<ElementRef<HTMLInputElement>>('attachInput');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');

  /** The editor's current inline HTML — used only for the send-button enabled state (empty editor ⇒ ''). The
   *  actual text payload is read via `editor.getText()` at send time. */
  readonly draftHtml = signal('');
  /** Emoji panel open flag. */
  readonly emojiOpen = signal(false);

  /** Recently-used emojis (persisted across sessions via localStorage). */
  readonly recents = signal<string[]>(loadRecents());
  /** Active tab id ('recent' for the Recents tab, else a category id). */
  readonly activeCategory = signal<string>(
    this.recents().length ? 'recent' : (EMOJI_CATEGORIES[0]?.id ?? ''),
  );

  /** Tabs to render: a Recents tab (when non-empty) prepended to the categorized tabs. Each carries an icon
   *  (the category's first glyph — Telegram-style) and its glyph list. */
  readonly emojiTabs = computed<EmojiTab[]>(() => {
    const rec = this.recents();
    const recentsTab: EmojiTab[] = rec.length
      ? [{ id: 'recent', label: 'Recent', icon: '🕐', icons: rec }]
      : [];
    const categoryTabs = EMOJI_CATEGORIES.map((c) => ({
      id: c.id,
      label: c.label,
      icon: c.icons[0] ?? '',
      icons: c.icons,
    }));
    return [...recentsTab, ...categoryTabs];
  });
  /** Delegated click on the prerendered grids wrapper: read the glyph from the clicked button's `data-emoji`
   *  and insert it. One handler for every category's buttons — far cheaper than a `(click)` binding + directive
   *  instance per emoji button across ~440 glyphs, and it stays valid as the active grid toggles (the buttons
   *  are never re-created on tab switch, only shown/hidden). */
  onGridClick(event: MouseEvent): void {
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-emoji]');
    if (btn) this.insertEmoji(btn.dataset['emoji']!);
  }

  // Editor content changed: track draft (send-button state) + re-measure the bar (auto-grow ⇒ heightChange).
  onHtml(h: string): void {
    this.draftHtml.set(h);
    this.measureBar();
  }

  /** Open/close the emoji panel. Opening to the Recents tab when there are recents (WhatsApp-style). */
  toggleEmoji(): void {
    if (this.emojiOpen()) { this.emojiOpen.set(false); return; }
    if (this.recents().length) this.activeCategory.set('recent');
    this.emojiOpen.set(true);
  }
  closeEmoji(): void {
    this.emojiOpen.set(false);
  }
  /** Insert the emoji at the editor caret, record it to Recents (move-to-front, dedup, capped), then refocus
   *  so typing continues. The editor manages caret restoration. */
  insertEmoji(e: string): void {
    this.editor()?.insertText(e);
    this.pushRecent(e);
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

  /** Move-to-front, dedup, cap at {@link RECENTS_MAX}; persist. */
  private pushRecent(e: string): void {
    const next = [e, ...this.recents().filter((x) => x !== e)].slice(0, RECENTS_MAX);
    this.recents.set(next);
    saveRecents(next);
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
