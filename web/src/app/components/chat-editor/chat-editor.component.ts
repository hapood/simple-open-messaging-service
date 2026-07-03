import {
  Component,
  ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
  ChangeDetectionStrategy,
  ViewEncapsulation,
} from '@angular/core';
import { Editor, Extension } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import { Mention } from '@tiptap/extension-mention';
import { Placeholder } from '@tiptap/extension-placeholder';

/** A mention candidate — id is stored on the chip (data-id), label is shown. Shape mirrors GroupMember
 *  so the production port swaps in GroupService.getMembers() unchanged. */
export interface ChatMember {
  id: string;
  label: string;
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
 * Enter convention (input-driven):
 *  - desktop: Enter sends (emits `send`); Shift+Enter and Ctrl/Cmd+Enter insert a newline.
 *  - mobile: Enter inserts a newline; send happens via the parent's send button.
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
  /** Mention candidates (playground: mock members; production: GroupService.getMembers()). Read into a
   *  ref so member updates do NOT recreate the editor (the init effect depends only on the host element). */
  readonly members = input<ChatMember[]>([]);
  /** Desktop → Enter sends; mobile → Enter inserts a newline. */
  readonly isDesktop = input(true);
  readonly placeholder = input('Type a message…');

  /** Fires on every keystroke with the current inline-HTML content (the value to store/send). */
  readonly html = output<string>();
  /** Fires on Enter (desktop, non-empty) — the parent sends the last html it received, then clear()s. */
  readonly send = output<void>();

  private readonly editorEl = viewChild<ElementRef<HTMLDivElement>>('editor');
  private editor?: Editor;

  /** Whether the editor currently has content (drives the send-button enabled state on the host). */
  readonly isEmpty = signal(true);

  private membersRef: ChatMember[] = [];
  /** Keep membersRef fresh without re-running the editor-init effect. */
  private readonly syncMembers = effect(() => {
    this.membersRef = this.members();
  });

  /** Create the Editor once the host element exists; destroy on cleanup. Reads members/isDesktop via
   *  refs/signals (not reactive inputs) so it never recreates on their change. */
  private readonly initEditor = effect((onCleanup) => {
    const el = this.editorEl()?.nativeElement;
    if (!el || this.editor) return;
    const editor = new Editor({
      element: el,
      extensions: [
        SendKeymapExtension({ onSend: () => this.onEnterSend(), isDesktop: () => this.isDesktop() }),
        StarterKit.configure({ heading: false }),
        Placeholder.configure({ placeholder: () => this.placeholder() }),
        Mention.configure({
          HTMLAttributes: { class: 'cb-mention' },
          suggestion: {
            char: '@',
            allowSpaces: false,
            items: ({ query }) => this.filterMembers(query),
            render: () => suggestionPopup(() => this.membersRef),
          },
        }),
      ],
      editorProps: {
        attributes: { class: 'cb-editor-prose', role: 'textbox', 'aria-multiline': 'true' },
      },
    });
    editor.on('update', () => {
      this.isEmpty.set(editor.isEmpty);
      this.html.emit(this.toInlineHtml(editor.getHTML()));
    });
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

  private filterMembers(query: string): ChatMember[] {
    const q = query.trim().toLowerCase();
    const src = this.membersRef;
    if (!q) return src.slice(0, 8);
    return src.filter((m) => m.label.toLowerCase().includes(q)).slice(0, 8);
  }

  // ---------- imperative API (parent drives via viewChild) ----------

  focus(): void {
    this.editor?.commands.focus();
  }

  /** Clear the editor (called by the parent after a successful send). */
  clear(): void {
    this.editor?.commands.clearContent(true);
  }

  /** Plain-text view of the editor content (block nodes separated by `\n`; mention atoms render as their
   *  label). Used by plain-text send mode — the composer UX is rich, but the stored/sent payload is text. */
  getText(): string {
    return this.editor?.getText() ?? '';
  }

  /** Insert text (or any inline content) at the caret — used by the emoji board. */
  insertText(content: string): void {
    this.editor?.chain().focus().insertContent(content).run();
  }
}

/**
 * High-priority Enter keymap. Desktop Enter → onSend (return true to swallow the default new-paragraph);
 * mobile Enter → hardBreak (newline). Shift+Enter is left to StarterKit's hardBreak; Ctrl/Cmd-Enter → hardBreak.
 */
function SendKeymapExtension(opts: {
  onSend: () => void;
  isDesktop: () => boolean;
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
                new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
              );
              return true;
            }
          }
          if (opts.isDesktop()) {
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
function suggestionPopup(getMembers: () => ChatMember[]) {
  void getMembers; // members are delivered via props.items (the items() callback result); kept for symmetry/future use
  let popup: HTMLDivElement | null = null;
  let items: ChatMember[] = [];
  let selected = 0;
  let command: ((m: ChatMember) => void) | null = null;

  const renderList = (): void => {
    if (!popup) return;
    popup.innerHTML = '';
    if (items.length === 0) {
      popup.classList.add('cb-mention-popup--empty');
      popup.textContent = 'No matches';
      return;
    }
    popup.classList.remove('cb-mention-popup--empty');
    items.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'cb-mention-item' + (i === selected ? ' cb-mention-item--active' : '');
      row.textContent = m.label;
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
    popup.style.left = `${Math.round(r.left)}px`;
    popup.style.top = `${Math.round(r.bottom + 6)}px`;
  };

  const close = (): void => {
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
      position(props.clientRect);
      renderList();
    },
    onUpdate: (props: RenderProps) => {
      items = props.items;
      selected = 0;
      command = props.command;
      position(props.clientRect);
      renderList();
    },
    onKeyDown: (props: { event: KeyboardEvent }) => {
      if (items.length === 0) return false;
      const n = items.length;
      if (props.event.key === 'ArrowDown') {
        selected = (selected + 1) % n;
        renderList();
        return true;
      }
      if (props.event.key === 'ArrowUp') {
        selected = (selected - 1 + n) % n;
        renderList();
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
