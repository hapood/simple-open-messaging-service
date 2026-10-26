import {
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
  ChangeDetectionStrategy,
  ViewEncapsulation,
} from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { LanguageService } from '../../services/language.service';
import { Editor, Extension } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Mention } from '@tiptap/extension-mention';
import { Placeholder } from '@tiptap/extension-placeholder';
import { InputDeviceService } from '../../services/input-device.service';
import { baseKeymap } from '@tiptap/pm/commands';
import { serializeEditorBlocks } from './editor-message-serializer';
import { ALL_MENTION_ID } from '../../lib/message-entity';
import type { AvatarProfileRef } from '../../services/avatar-profile-ref';
import { Subscription } from 'rxjs';
import {
  AvatarPresentationService,
  initialAvatarView,
} from '../user-avatar/avatar-presentation.service';
import { avatarBackground, avatarInitial } from '../user-avatar/avatar-view';

/** A mention candidate — id is stored on the chip (data-id, a full SOMFP user address), label is
 *  shown. Produced by the host's memberSearch lookup. */
export interface ChatMember {
  id: string;
  label: string;
  profile?: AvatarProfileRef;
}

export interface ComposerLinkMarker {
  href: string;
  start: number;
  end: number;
}

/**
 * Chat composer built on Tiptap (ProseMirror): atomic @mention chips, simple inline formatting
 * (bold/italic/code via StarterKit), and a configurable Enter convention.
 *
 * Zoneless bridge: the Editor is created in an effect once its host element exists (ngAfterViewInit is
 * unreliable zoneless — see the zoneless-viewchild memory), torn down on cleanup. ProseMirror events
 * (update) are bridged to Angular outputs imperatively — no NgZone, no two-way binding; the parent reads
 * the emitted html and calls clear()/insertText() via a viewChild ref.
 *
 * Enter convention (device-dependent, keyed on {@link InputDeviceService.enterToSend} — NOT viewport width):
 *  - physical keyboard: Enter sends (emits `send`); Shift+Enter and Ctrl/Cmd+Enter insert a newline.
 *  - touch (soft keyboard): Enter inserts a newline; send happens via the parent's send button.
 * The Enter keymap lives in a high-priority extension so it wins over StarterKit's paragraph Enter.
 *
 * Atomic mentions: the Mention extension renders each mention as an atom node (contenteditable=false) →
 * backspace deletes the whole chip and the caret cannot enter it (default behavior; avoids the known
 * contenteditable=false caret bug). getHTML() yields `<span class="cb-mention" data-id=.. data-label=..>`
 * which the message card renders via Angular's sanitized [innerHTML] (the class survives; data-* are
 * display-irrelevant). The serialized/stored form strips the outer <p> so it is inline HTML.
 */
@Component({
  selector: 'app-chat-editor',
  standalone: true,
  templateUrl: './chat-editor.component.html',
  styleUrl: './chat-editor.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class ChatEditorComponent {
  readonly memberSearch = input<
    ((query: string) => Promise<ChatMember[]>) | undefined
  >();
  readonly mentionsEnabled = input(false);
  readonly placeholder = input('');
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);
  private readonly presentations = inject(AvatarPresentationService);
  /** INPUT axis (physical vs soft keyboard) — drives the Enter convention
   *  ({@link InputDeviceService.enterToSend}). Injected rather than threaded through every host. */
  private readonly inputDevice = inject(InputDeviceService);

  /** Fires on every keystroke with the current inline-HTML content (the value to store/send). */
  readonly html = output<string>();
  /** Structured links already recognized by Tiptap. Consumers must not parse the full draft again. */
  readonly linkMarkers = output<readonly ComposerLinkMarker[]>();
  /** Fires on Enter (desktop, non-empty) — the parent sends the last html it received, then clear()s. */
  readonly send = output<void>();
  /** Fires only when a paste contains real clipboard files. Returning true from ProseMirror's paste
   *  handler keeps those files/HTML out of the text editor; the host opens the dedicated paste panel. */
  readonly attachmentPaste = output<ClipboardEvent>();
  readonly focusChange = output<boolean>();

  private readonly editorEl = viewChild<ElementRef<HTMLDivElement>>('editor');
  private editor?: Editor;

  /** Whether the editor currently has content (drives the send-button enabled state on the host). */
  readonly isEmpty = signal(true);

  /** Force the Tiptap Placeholder to re-evaluate its placeholder function on a language switch — the
   *  placeholder reads the active language, and without a transaction the empty-state hint would stay in
   *  the previous language until the next keystroke/focus. A no-op transaction triggers a view update that
   *  recomputes the Placeholder decoration (it only repaints while the editor is empty, the common case). */
  private readonly refreshPlaceholder = effect(() => {
    this.language.lang();
    const ed = this.editor;
    if (ed) ed.view.dispatch(ed.state.tr.setMeta('langChanged', true));
  });

  /** Create the Editor once the host element exists; destroy on cleanup. Reads members/hasFinePointer via
   *  refs/signals (not reactive inputs) so it never recreates on their change. */
  private readonly initEditor = effect((onCleanup) => {
    const el = this.editorEl()?.nativeElement;
    if (!el || this.editor) return;
    // Android WebView handles the first user-initiated contenteditable focus through its normal path to
    // create the InputConnection. Subsequent emoji/ABC visibility handoffs use the native SomsShell bridge.
    const editor = new Editor({
      element: el,
      extensions: [
        SendKeymapExtension({
          onSend: () => this.onEnterSend(),
          enterToSend: () => this.inputDevice.enterToSend(),
        }),
        StarterKit.configure({
          heading: false,
          // Composer links are paint-only. Autolink may decorate the changed text, but a tap/click must
          // remain an ordinary editor interaction and must never navigate away from the draft.
          link: { openOnClick: false },
        }),
        Placeholder.configure({
          placeholder: () =>
            this.placeholder() ||
            this.transloco.translate('chat.inputPlaceholder'),
        }),
        Mention.configure({
          HTMLAttributes: { class: 'cb-mention' },
          suggestion: {
            char: '@',
            allowSpaces: false,
            // P2P conversations deliberately disable mentions. Do not start a suggestion session at
            // all there: showing an empty popup makes a literal @ look like a supported P2P mention.
            allow: () => this.mentionsEnabled(),
            items: ({ query }) => this.memberSearch()?.(query) ?? [],
            render: () => suggestionPopup(this.presentations),
          },
        }),
      ],
      editorProps: {
        handlePaste: (_view, event) => {
          if (!event.clipboardData || event.clipboardData.files.length === 0)
            return false;
          this.attachmentPaste.emit(event);
          return true;
        },
        attributes: {
          class: 'cb-editor-prose',
          role: 'textbox',
          'aria-multiline': 'true',
        },
      },
    });
    editor.on('update', () => {
      this.isEmpty.set(editor.isEmpty);
      this.html.emit(this.toInlineHtml(editor.getHTML()));
      this.linkMarkers.emit(this.getLinkMarkers());
    });
    editor.on('focus', () => this.focusChange.emit(true));
    editor.on('blur', () => this.focusChange.emit(false));
    this.editor = editor;
    onCleanup(() => {
      editor.destroy();
      this.editor = undefined;
    });
  });

  /** Desktop Enter (non-empty): notify the parent to send. */
  private onEnterSend(): void {
    if (this.editor && !this.editor.isEmpty) this.send.emit();
  }

  /** Convert editor HTML (one <p>…</p>, possibly with <br> for Shift-Enter) to inline HTML for storage.
   *  Multiline paste (multiple <p>) collapses to <br>-separated inline content. */
  private toInlineHtml(html: string): string {
    return html
      .replace(/<\/p>\s*<p[^>]*>/g, '<br>')
      .replace(/^<p[^>]*>/, '')
      .replace(/<\/p>$/, '');
  }

  // ---------- imperative API (parent drives via viewChild) ----------

  focus(): void {
    this.editor?.commands.focus();
  }

  isFocused(): boolean {
    return this.editor?.isFocused ?? false;
  }

  /** Remove DOM focus without losing the ProseMirror selection. Used when the touch emoji/attachment
   *  surface replaces the system keyboard. */
  blur(): void {
    this.editor?.commands.blur();
  }

  /** Clear the editor (called by the parent after a successful send). */
  clear(): void {
    this.editor?.commands.clearContent(true);
  }

  /** Restore trusted, account-local composer HTML from IndexedDB. */
  setHtml(content: string): void {
    this.editor?.commands.setContent(content ? `<p>${content}</p>` : '<p></p>');
  }

  /** Plain-text view of the editor content (block nodes separated by `\n`; mention atoms render as their
   *  label). Used by plain-text send mode — the composer UX is rich, but the stored/sent payload is text. */
  getText(): string {
    return this.editor?.getText() ?? '';
  }

  /** Read existing link marks without rerunning URL recognition over the draft text. */
  getLinkMarkers(): ComposerLinkMarker[] {
    const editor = this.editor;
    if (!editor) return [];
    const markers: ComposerLinkMarker[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const link = node.marks.find((mark) => mark.type.name === 'link');
      const href = link?.attrs['href'];
      if (typeof href !== 'string' || !href) return;
      const previous = markers.at(-1);
      if (previous?.href === href && previous.end === pos) {
        previous.end = pos + node.nodeSize;
      } else {
        markers.push({ href, start: pos, end: pos + node.nodeSize });
      }
    });
    return markers;
  }

  /**
   * Serialize the editor document for Message.content. Plain text is escaped as plain text, while only
   * an atomic Tiptap mention node becomes a SOMS user entity. Consequently typing/pasting the complete
   * protocol by hand can never promote it into a real mention.
   */
  getStorageText(): string {
    const doc = this.editor?.getJSON();
    if (!doc?.content) return '';
    return serializeEditorBlocks(doc.content);
  }

  /** Insert text (or any inline content) at the last selection. Touch emoji keyboards deliberately keep
   *  the editor blurred so inserting a glyph does not summon the system IME again. */
  insertText(content: string, focus = true): void {
    const chain = this.editor?.chain();
    if (!chain) return;
    if (focus) chain.focus();
    chain.insertContent(content).run();
  }

  /** Preserve the current draft and append plain text at the document end. Clipboard text accompanying
   * files uses this instead of replacing the draft or becoming a separate paste-panel field. */
  appendText(content: string, focus = true): void {
    if (!content || !this.editor) return;
    const inlineContent = content
      .split(/\r?\n/)
      .flatMap((line, index) => [
        ...(index ? [{ type: 'hardBreak' }] : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ]);
    if (this.editor.getText()) inlineContent.unshift({ type: 'hardBreak' });
    const chain = this.editor.chain();
    if (focus) chain.focus();
    chain
      .setTextSelection(this.editor.state.doc.content.size)
      .insertContent(inlineContent)
      .run();
  }

  /** Run ProseMirror's real Backspace command so selections, mentions and Unicode text are deleted with
   *  the same semantics as the native keyboard. */
  deleteBackward(focus = true): void {
    const editor = this.editor;
    if (!editor) return;
    if (focus) editor.commands.focus();
    baseKeymap['Backspace']?.(
      editor.state,
      (transaction) => editor.view.dispatch(transaction),
      editor.view,
    );
  }
}

/**
 * High-priority Enter keymap. Physical-keyboard Enter → onSend (return true to swallow the default
 * new-paragraph); soft-keyboard Enter → hardBreak (newline). The `enterToSend` opt is the Enter rule's
 * single switch point ({@link InputDeviceService.enterToSend}). Shift+Enter is left to StarterKit's
 * hardBreak; Ctrl/Cmd-Enter → hardBreak.
 */
function SendKeymapExtension(opts: {
  onSend: () => void;
  enterToSend: () => boolean;
}) {
  return Extension.create({
    name: 'sendKeymap',
    priority: 1000,
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          // If the @mention popup is open, select the highlighted item directly. This high-priority keymap
          // wins over the suggestion plugin's own key handler, so we can't just `return false` (StarterKit's
          // paragraph Enter would then consume it). Dispatch the active row's mousedown — the popup's own
          // listener calls the mention command with { id, label }, inserting the atom chip.
          if (typeof document !== 'undefined') {
            const active = document.querySelector('.cb-mention-item--active');
            if (active) {
              active.dispatchEvent(
                new MouseEvent('mousedown', {
                  bubbles: true,
                  cancelable: true,
                }),
              );
              return true;
            }
          }
          if (opts.enterToSend()) {
            opts.onSend();
            return true;
          }
          editor.commands.setHardBreak();
          return true;
        },
        'Mod-Enter': ({ editor }) => {
          editor.commands.setHardBreak();
          return true;
        },
      };
    },
  });
}

/**
 * Vanilla-DOM mention suggestion popup (positioned at the caret via Floating-UI-style clientRect). Appended
 * to document.body so it escapes any overflow/transform on the host; keyboard-nav + click both call the
 * mention command with { id, label } (the atom node attrs). Returns the render() handlers Tiptap expects.
 */
export function suggestionPopup(presentations: AvatarPresentationService) {
  let subscriptions = new Subscription();
  let popup: HTMLDivElement | null = null;
  let items: ChatMember[] = [];
  let selected = 0;
  let command: ((m: ChatMember) => void) | null = null;

  const renderList = (): void => {
    if (!popup) return;
    subscriptions.unsubscribe();
    subscriptions = new Subscription();
    popup.innerHTML = '';
    if (items.length === 0) {
      popup.classList.add('cb-mention-popup--empty');
      popup.textContent = 'No matches';
      return;
    }
    popup.classList.remove('cb-mention-popup--empty');
    items.forEach((m, i) => {
      const row = document.createElement('div');
      row.className =
        'cb-mention-item' + (i === selected ? ' cb-mention-item--active' : '');
      if (m.id === ALL_MENTION_ID) {
        row.classList.add('cb-mention-item--all');
        const icon = document.createElement('span');
        icon.className = 'cb-mention-all-icon';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = `@${m.label}`;
        row.append(icon, label);
      } else {
        const label = document.createElement('span');
        label.className = 'cb-mention-label';
        label.textContent = m.label;
        const avatar = document.createElement('span');
        avatar.className = 'cb-mention-avatar';
        avatar.setAttribute('aria-hidden', 'true');
        avatar.textContent = avatarInitial(m.label);
        avatar.style.background = avatarBackground(
          initialAvatarView({
            kind: 'snapshot',
            name: m.label,
            imageUrl: null,
            account: m.id,
          }),
        );
        row.append(avatar, label);
        if (m.profile) {
          subscriptions.add(
            presentations
              .resolve({
                kind: 'demand',
                profile: m.profile,
                account: m.profile.account,
                fallbackName: m.label,
              })
              .subscribe((view) => {
                // The selected reference is fixed for this result page. Presentation
                // arrival updates only its row, never reruns the search.
                m.label = view.name;
                label.textContent = view.name;
                avatar.style.background = avatarBackground(view);
                let image = avatar.querySelector('img');
                if (view.imageUrl) {
                  if (!image) {
                    image = document.createElement('img');
                    image.alt = '';
                    image.width = 32;
                    image.height = 32;
                    image.onerror = () => {
                      avatar.textContent = avatarInitial(m.label);
                    };
                    avatar.replaceChildren(image);
                  }
                  image.src = view.imageUrl;
                } else {
                  avatar.textContent = avatarInitial(view.name);
                }
              }),
          );
        }
      }
      // mousedown (not click) so the editor does not blur before the command runs.
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        command?.(m);
      });
      popup!.appendChild(row);
    });
  };

  const position = (rect: (() => DOMRect | null) | null | undefined): void => {
    if (!popup || !rect) return;
    const r = rect();
    if (!r) return;
    const gap = 6;
    const margin = 8;
    const popupRect = popup.getBoundingClientRect();
    const width = popupRect.width;
    const height = popupRect.height;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const left = Math.min(
      Math.max(r.left, margin),
      Math.max(margin, viewportWidth - width - margin),
    );
    const fitsBelow = r.bottom + gap + height <= viewportHeight - margin;
    const top = fitsBelow
      ? r.bottom + gap
      : Math.max(margin, r.top - gap - height);
    popup.style.left = `${Math.round(left)}px`;
    popup.style.top = `${Math.round(top)}px`;
  };

  const paintSelection = (): void => {
    popup?.querySelectorAll('.cb-mention-item').forEach((row, index) => {
      row.classList.toggle('cb-mention-item--active', index === selected);
    });
  };

  const close = (): void => {
    subscriptions.unsubscribe();
    popup?.remove();
    popup = null;
    command = null;
  };

  type RenderProps = {
    items: ChatMember[];
    clientRect?: (() => DOMRect | null) | null;
    command: (m: ChatMember) => void;
  };

  return {
    onStart: (props: RenderProps) => {
      items = props.items;
      selected = 0;
      command = props.command;
      popup = document.createElement('div');
      popup.className = 'cb-mention-popup';
      document.body.appendChild(popup);
      renderList();
      position(props.clientRect);
    },
    onUpdate: (props: RenderProps) => {
      items = props.items;
      selected = 0;
      command = props.command;
      renderList();
      position(props.clientRect);
    },
    onKeyDown: (props: { event: KeyboardEvent }) => {
      if (items.length === 0) return false;
      const n = items.length;
      if (props.event.key === 'ArrowDown') {
        selected = (selected + 1) % n;
        paintSelection();
        return true;
      }
      if (props.event.key === 'ArrowUp') {
        selected = (selected - 1 + n) % n;
        paintSelection();
        return true;
      }
      if (props.event.key === 'Enter') {
        if (items[selected]) command?.(items[selected]);
        return true;
      }
      return false;
    },
    onExit: () => close(),
  };
}
