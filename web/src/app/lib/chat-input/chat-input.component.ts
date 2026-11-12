import type {
  ChatSurfaceBinding,
  ChatSurfaceLifecycle,
} from '../../components/message-thread/chat-surface-lifecycle';
import {
  untracked,
  Component,
  ChangeDetectionStrategy,
  ViewEncapsulation,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import {
  ChatEditorComponent,
  type ChatMember,
  type ComposerLinkMarker,
} from '../../components/chat-editor/chat-editor.component';
import {
  IconComponent,
  AppIconType,
} from '../../components/icon/icon.component';
import { PreventFocusStealDirective } from '../../directives/prevent-focus-steal.directive';
import { EMOJI_CATEGORIES } from './emoji-data';
import { firstValueFrom, finalize, Subscription } from 'rxjs';
import { microphoneStream } from './microphone-stream';
import { KeyboardInsetService } from '../../services/keyboard-inset.service';
import {
  NativeUploadService,
  type NativeUploadSelection,
} from '../../services/native-upload.service';
import { isVoiceRecordingTooShort } from './voice-recording-state';
import { PreferenceStore } from '../../services/preference-store.service';
import {
  LinkCardGenerationService,
  type LinkCardContent,
} from '../../services/link-card-generation.service';
import {
  PopupType,
  RouteService,
  type DlgRef,
} from '../../services/route.service';
import { ComposerDraftService } from '../../services/composer-draft.service';
import { assetUrl } from '../../services/runtime';
import { ToastService } from '../../services/toast.service';
import type { ContactCardPreview } from '../../services/model';

/**
 * A structured send intent emitted by {@link ChatInputComponent}. One discriminated union (rather than three
 * separate outputs) so the parent subscribes once and chronological order is preserved across rapid sends,
 * and so the parent's switch is exhaustive (TS forces handling every kind). The component never dispatches —
 * it only reports what the user wants to send; the host owns the optimistic-insert + HTTP/reconcile logic.
 */
export type ChatSendIntent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; files: readonly File[] }
  | { kind: 'file'; files: readonly File[] }
  | { kind: 'native-files'; files: readonly NativeUploadSelection[] }
  | { kind: 'link'; generationId: string; content: LinkCardContent }
  | ({ kind: 'contact' } & ContactCardPreview)
  | { kind: 'paste'; text: string; files: readonly File[] }
  | { kind: 'audio'; blob: Blob; duration: number; mimeType: string };

/** A category/tab shown in the emoji panel (Recents is a synthetic tab when non-empty). The accessible
 *  label is NOT carried here — the template resolves it via `chat.emojiTab.<id>` (transloco), keyed by `id`. */
interface EmojiTab {
  readonly id: string;
  readonly icon: string;
  readonly icons: readonly string[];
}

const RECENTS_KEY = 'soms.chat.emojiRecents';
const RECENTS_MAX = 32;
const RECORD_HOLD_DELAY_MS = 320;

/** Pick the best audio MIME the current browser can RECORD. MediaRecorder output varies by engine:
 *  Chrome / Android WebView / Tauri webview2 / webkit2gtk → audio/webm (opus); Safari / iOS / macOS
 *  wkwebview → audio/mp4; Firefox → audio/ogg (opus). The unified upload endpoint accepts all of these
 *  (EBML/ftyp are shared audio/video containers — see consumeMedia's sharedAsAudio branch). '' ⇒ the
 *  engine cannot record audio at all; the caller surfaces that and bails. */
function pickRecorderMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* isTypeSupported can throw on an unknown MIME in some engines — skip it */
    }
  }
  return '';
}

/** Hard cap on a single voice clip; release still decides send versus discard. */
const MAX_RECORD_SECS = 60;
/**
 * Reusable chat composer (WhatsApp-style capsule + round send key), shared by the chatbox playground and the
 * production message thread.
 *
 *  - Owns presentation ONLY: the Tiptap editor, the emoji panel + click-to-close backdrop, the image/file
 *    pickers, the send button (paper-plane when there is draft text, camera when empty), auto-grow height
 *    measurement, and `appPreventFocusSteal` on every icon (mobile keyboard avoidance — see the
 *    `input-bar-icon-no-focus-steal` memory).
 *  - Emits {@link ChatSendIntent} on send; the host does the rest. Composer geometry is fixed by the global
 *    width policy, so typing never schedules a layout measurement here.
 *
 * Emoji panel: a WhatsApp/Telegram-style category grid with persisted Recents. Browser/PWA and desktop use
 * a floating panel without controlling the system keyboard. The Android native shell renders the same grid
 * in-flow as a keyboard replacement and uses one atomic native IME visibility capability.
 *
 * Plain-text payload: the editor is rich for composition UX, but the text send serializes to plain text
 * (`editor.getText()`) — no HTML is stored. `memberSearch` drives the @mention suggestion popup (a group
 * host passes its member-roster lookup; 1-on-1 leaves it unset where mentions are meaningless).
 *
 * `ViewEncapsulation.None` + the `ci-` prefix (mirrors the playground's global `pg-` pattern): the styles are
 * global, loaded once `<app-chat-input>` renders in either host.
 */
@Component({
  selector: 'app-chat-input',
  imports: [
    ChatEditorComponent,
    PreventFocusStealDirective,
    IconComponent,
    TranslocoModule,
  ],
  templateUrl: './chat-input.component.html',
  styleUrl: './chat-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class ChatInputComponent implements OnDestroy {
  readonly AppIconType = AppIconType;
  private readonly nativeUploads = inject(NativeUploadService);
  private readonly toast = inject(ToastService);
  private readonly transloco = inject(TranslocoService);
  readonly memberSearch = input<
    ((query: string) => Promise<ChatMember[]>) | undefined
  >();
  readonly mentionsEnabled = input(false);
  readonly placeholder = input('');
  /** Browser composer drafts are partitioned by conversation. Omit in the playground. */
  readonly threadId = input<number>();
  readonly enabled = input(true);
  readonly lifecycle = input<ChatSurfaceLifecycle>();
  readonly interactive = signal(false);
  private boundContext?: ChatSurfaceBinding;
  private imagePickerBinding?: ChatSurfaceBinding;
  private filePickerBinding?: ChatSurfaceBinding;
  /** Reserved compact presentation: constrains only the editor height to one line. Current chatbox dialogs
   *  hide the composer; keep this input for a future interaction mode without changing its width. */
  readonly compact = input(false);
  /** Disable the send key + ignore Enter while a send/upload is in flight (parent-driven). */
  readonly sending = input(false);
  /** Structured send intent — the host switches on `kind`. */
  readonly send = output<ChatSendIntent>();

  private readonly editor = viewChild(ChatEditorComponent);
  private readonly inputBar =
    viewChild<ElementRef<HTMLFormElement>>('inputBar');
  private readonly attachInput =
    viewChild<ElementRef<HTMLInputElement>>('attachInput');
  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly recordCancelTarget =
    viewChild<ElementRef<HTMLElement>>('recordCancelTarget');
  private readonly keyboardInset = inject(KeyboardInsetService);
  private readonly preferences = inject(PreferenceStore);
  private readonly generations = inject(LinkCardGenerationService);
  private readonly route = inject(RouteService);
  private readonly composerDrafts = inject(ComposerDraftService);
  private recentsWriteRevision = 0;

  /** The editor's current inline HTML — used only for the send-button enabled state (empty editor ⇒ ''). The
   *  actual text payload is read via `editor.getText()` at send time. */
  readonly draftHtml = signal('');
  /** Browser/desktop emoji remains a simple floating popup. Android uses its native composer instead. */
  readonly emojiOpen = signal(false);
  readonly detectedLink = signal<string | null>(null);
  readonly generationId = signal<string | null>(null);
  readonly generationStarting = signal(false);
  readonly generationStartFailed = signal(false);
  readonly linkGeneration = computed(() => {
    const id = this.generationId();
    return id ? this.generations.snapshot(id) : undefined;
  });
  readonly linkState = computed<'idle' | 'pending' | 'succeeded' | 'failed'>(
    () => {
      if (this.generationStarting()) return 'pending';
      if (this.generationStartFailed()) return 'failed';
      return this.linkGeneration()?.status ?? 'idle';
    },
  );
  readonly linkFavicon = computed(() =>
    assetUrl(
      this.linkGeneration()?.favicon ?? this.linkGeneration()?.content?.favicon,
    ),
  );
  private linkTimer?: ReturnType<typeof setTimeout>;
  private pendingLinkUrl: string | null = null;
  /** Link-card generation can become user-triggered while the draft is still local to the open composer.
   *  Keep that bit locally as well; publishing it through ComposerDraftService would make the thread-list
   *  draft preview update while the user is typing. */
  private generationTriggered = false;
  private restoredThreadId?: number;
  private openWhenStarted = false;

  /** Recently-used emojis (persisted across sessions via the preference store, device scope). */
  readonly recents = signal<string[]>([]);
  /** Active tab id ('recent' for the Recents tab, else a category id). */
  readonly activeCategory = signal<string>(
    this.recents().length ? 'recent' : (EMOJI_CATEGORIES[0]?.id ?? ''),
  );

  /** Tabs to render: a Recents tab (when non-empty) prepended to the categorized tabs. Each carries an icon
   *  (the category's first glyph — Telegram-style) and its glyph list. */
  readonly emojiTabs = computed<EmojiTab[]>(() => {
    const rec = this.recents();
    const recentsTab: EmojiTab[] = rec.length
      ? [{ id: 'recent', icon: '🕐', icons: rec }]
      : [];
    const categoryTabs = EMOJI_CATEGORIES.map((c) => ({
      id: c.id,
      icon: c.icons[0] ?? '',
      icons: c.icons,
    }));
    return [...recentsTab, ...categoryTabs];
  });

  constructor() {
    void this.restoreRecents();
    effect((onCleanup) => {
      const lifecycle = this.lifecycle();
      if (!lifecycle) return;
      const subscription = lifecycle.state$.subscribe((state) =>
        untracked(() => {
          this.interactive.set(
            state.phase === 'bound' && state.foreground && this.enabled(),
          );
          this.synchronizeBinding(
            state.phase === 'bound' && this.enabled()
              ? state.binding
              : undefined,
            this.editor(),
          );
        }),
      );
      onCleanup(() => subscription.unsubscribe());
    });
    effect(() => {
      const lifecycle = this.lifecycle();
      const enabled = this.enabled();
      const editor = this.editor();
      untracked(() => {
        const state = lifecycle?.state();
        this.interactive.set(
          state?.phase === 'bound' && state.foreground && enabled,
        );
        this.synchronizeBinding(
          enabled ? lifecycle?.binding : undefined,
          editor,
        );
      });
    });
  }

  private synchronizeBinding(
    binding: ChatSurfaceBinding | undefined,
    editor: ReturnType<ChatInputComponent['editor']>,
  ): void {
    const threadId = binding?.threadId;
    if (this.boundContext !== binding) {
      this.unbind();
      if (binding?.signal.aborted) return;
      this.boundContext = binding;
    }
    if (!threadId || !editor || this.restoredThreadId === threadId) return;
    this.restoredThreadId = threadId;
    const draft = this.composerDrafts.get(threadId);
    if (!draft) return;
    this.generationTriggered = Boolean(draft.generationTriggered);
    editor.setHtml(draft.html);
    this.draftHtml.set(draft.html);
    this.pendingLinkUrl = draft.linkUrl ?? null;
    this.detectedLink.set(this.pendingLinkUrl);
    if (
      draft.generationId &&
      draft.generationExpiresAt &&
      draft.generationExpiresAt > Date.now()
    ) {
      this.generationId.set(draft.generationId);
      this.generations.resume({
        generationId: draft.generationId,
        status: 'pending',
        expiresAt: draft.generationExpiresAt,
      });
    } else if (draft.linkUrl && draft.generationTriggered) {
      void this.startGeneration(draft.plainText, draft.linkUrl, true);
    }
  }
  /** Delegated click on the prerendered grids wrapper: read the glyph from the clicked button's `data-emoji`
   *  and insert it. One handler for every category's buttons — far cheaper than a `(click)` binding + directive
   *  instance per emoji button across ~440 glyphs, and it stays valid as the active grid toggles (the buttons
   *  are never re-created on tab switch, only shown/hidden). */
  onGridClick(event: MouseEvent): void {
    const btn = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-emoji]',
    );
    if (btn) this.insertEmoji(btn.dataset['emoji']!);
  }

  // Editor content changed: track draft (send-button state); excess lines scroll inside the fixed editor.
  onHtml(h: string): void {
    this.draftHtml.set(h);
  }

  /** The editor recognizes native-compatible URL candidates; debounce their presentation here. */
  onLinkMarkers(markers: readonly ComposerLinkMarker[]): void {
    this.pendingLinkUrl = markers[0]?.href ?? null;
    this.scheduleLinkDetection();
  }

  /** A clipboard payload containing files belongs in the roomy review panel, not in the compact editor.
   *  The editor has already prevented its default insertion before calling this method. */
  onAttachmentPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (!data) return;
    const files = Array.from(data.files);
    if (files.length === 0) return;
    this.closeEmoji();
    this.closeAttach();
    this.send.emit({
      kind: 'paste',
      text: data.getData('text/plain'),
      files,
    });
  }

  appendText(text: string): void {
    this.editor()?.appendText(text);
  }

  private scheduleLinkDetection(): void {
    clearTimeout(this.linkTimer);
    this.linkTimer = setTimeout(() => this.detectAndMaybeGenerate(), 500);
  }

  private detectAndMaybeGenerate(): void {
    const url = this.pendingLinkUrl;
    if (url !== this.detectedLink()) this.resetGeneration();
    this.detectedLink.set(url);
  }

  private generationRequest?: Subscription;

  private startGeneration(
    text: string,
    url: string,
    triggered: boolean,
    requestedGenerationId?: string,
  ): void {
    this.generationRequest?.unsubscribe();
    this.generationStarting.set(true);
    this.generationStartFailed.set(false);
    if (triggered) this.generationTriggered = true;
    this.generationRequest = this.generations
      .begin$(url, text, requestedGenerationId)
      .pipe(
        finalize(() => {
          this.generationStarting.set(false);
          this.openWhenStarted = false;
        }),
      )
      .subscribe({
        next: (state) => {
          if (
            requestedGenerationId &&
            requestedGenerationId !== state.generationId
          )
            this.generations.forget(requestedGenerationId);
          this.generationId.set(state.generationId);
          this.generationTriggered = true;
          if (this.openWhenStarted) this.openGenerationDialog();
        },
        error: () => this.generationStartFailed.set(true),
      });
  }

  onLinkClick(): void {
    const url = this.detectedLink();
    if (!url) return;
    if (!this.generationId()) {
      this.openWhenStarted = true;
      if (!this.generationStarting())
        void this.startGeneration(this.editor()?.getText() ?? '', url, true);
      return;
    }
    if (this.linkState() === 'failed') {
      if (this.linkGeneration()?.content) {
        this.openGenerationDialog();
        return;
      }
      const generationId = this.generationId();
      this.openWhenStarted = true;
      void this.startGeneration(
        this.editor()?.getText() ?? '',
        url,
        true,
        generationId ?? undefined,
      );
      return;
    }
    this.openGenerationDialog();
  }

  onComposerInteraction(event: PointerEvent): void {
    if (!this.compact()) return;
    const target = event.target as Element | null;
    if (target?.closest('.ci-input')) this.route.closeDlg();
  }

  private generationDialog?: DlgRef;

  private closeGenerationDialog(): void {
    const dialog = this.generationDialog;
    this.generationDialog = undefined;
    if (dialog) this.route.closeDialogAndAbove(dialog);
  }

  private openGenerationDialog(): void {
    const generationId = this.generationId();
    if (!generationId || this.generationDialog) return;
    this.generationDialog = this.route.popupDlg(
      PopupType.LINK_CARD_GENERATION,
      {
        generationId,
        mode: 'composer',
        originalText: this.editor()?.getText() ?? '',
      },
      (result) => {
        this.generationDialog = undefined;
        if (result?.kind === 'retry') {
          const url = this.detectedLink();
          if (!url) return;
          this.openWhenStarted = true;
          void this.startGeneration(
            this.editor()?.getText() ?? '',
            url,
            true,
            generationId,
          );
          return;
        }
        if (result?.kind !== 'link') return;
        this.clearDraft();
        this.send.emit({
          kind: 'link',
          generationId: result.generationId,
          content: result.content,
        });
      },
      { scopeThreadId: this.threadId() },
    );
  }

  /** Commit the open composer's local state when its chat is being left. Keeping this explicit is
   *  important on desktop, where the A/B chat panes remain mounted after a switch. */
  saveDraft(): void {
    const threadId = this.boundContext?.threadId;
    const editor = this.editor();
    if (!threadId || !editor) return;
    const generation = this.linkGeneration();
    this.composerDrafts.save({
      threadId,
      html: this.draftHtml(),
      plainText: editor.getText(),
      linkUrl: this.detectedLink() ?? undefined,
      generationId: this.generationId() ?? undefined,
      generationExpiresAt: generation?.expiresAt,
      generationTriggered:
        this.generationTriggered || Boolean(this.generationId()),
      updatedAt: Date.now(),
    });
  }

  private resetGeneration(): void {
    this.closeGenerationDialog();
    this.generationRequest?.unsubscribe();
    this.generationRequest = undefined;
    const id = this.generationId();
    if (id) this.generations.forget(id);
    this.generationId.set(null);
    this.generationStarting.set(false);
    this.generationStartFailed.set(false);
  }

  private clearDraft(): void {
    const threadId = this.threadId();
    this.editor()?.clear();
    this.draftHtml.set('');
    this.pendingLinkUrl = null;
    this.detectedLink.set(null);
    this.generationTriggered = false;
    this.resetGeneration();
    if (threadId) this.composerDrafts.clear(threadId);
  }

  /** Open/close the emoji panel. Opening to the Recents tab when there are recents (WhatsApp-style). */
  toggleEmoji(): void {
    if (this.emojiOpen()) {
      this.closeEmoji();
      return;
    }
    this.closeAttach();
    if (this.recents().length) this.activeCategory.set('recent');
    this.emojiOpen.set(true);
    this.editor()?.focus();
  }
  closeEmoji(): void {
    this.emojiOpen.set(false);
  }
  /** Insert at the live editor selection and record it to Recents. */
  insertEmoji(e: string): void {
    this.editor()?.insertText(e);
    this.pushRecent(e);
  }

  /** Close transient composer surfaces when interaction leaves the composer. */
  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.emojiOpen() && !this.attachOpen()) return;
    const target = event.target;
    if (!(target instanceof Node)) {
      this.closeEmoji();
      this.closeAttach();
      return;
    }

    const inputBar = this.inputBar()?.nativeElement;
    if (!inputBar?.contains(target)) this.closeEmoji();

    // Unlike the emoji panel, the attachment drawer only owns its trigger and drawer surface. Treat the
    // editor, controls-row padding and every other blank part of the composer as outside-click territory.
    // This also covers the rail to the left of the centered controls on wide chat panes.
    const element =
      target instanceof Element
        ? target
        : target.parentNode instanceof Element
          ? target.parentNode
          : null;
    if (
      this.attachOpen() &&
      !element?.closest('.ci-attach, .ci-attach-drawer-shell')
    ) {
      this.closeAttach();
    }
  }

  /** Desktop Enter (the editor's `send` output): same as the text branch of the send key. */
  onEditorSend(): void {
    if (this.sending()) return;
    this.sendText();
  }

  /** A normal click sends text unless it is the synthetic click following a completed hold gesture. */
  onSendClick(): void {
    if (this.suppressNextSendClick) {
      this.suppressNextSendClick = false;
      return;
    }
    if (!this.sending() && this.draftHtml()) this.sendText();
  }

  private sendText(): void {
    if (!this.boundContext || this.boundContext.signal.aborted) return;
    const editor = this.editor();
    if (!editor) return;
    const displayText = editor.getText().trim();
    if (!displayText) return;
    const storageText = editor.getStorageText().trim();
    editor.clear();
    this.draftHtml.set('');
    this.pendingLinkUrl = null;
    this.detectedLink.set(null);
    this.resetGeneration();
    clearTimeout(this.linkTimer);
    const threadId = this.threadId();
    if (threadId) this.composerDrafts.clear(threadId);
    this.closeEmoji();
    this.closeAttach();
    this.send.emit({ kind: 'text', text: storageText });
  }

  onAttachClick(): void {
    const binding = this.boundContext;
    if (!binding || binding.signal.aborted) return;
    if (this.nativeUploads.supported()) {
      void this.nativeUploads.pick('image').then(
        (files) => {
          if (binding.signal.aborted) return;
          if (files.length) this.send.emit({ kind: 'native-files', files });
        },
        () => {
          if (!binding.signal.aborted)
            this.toast.warn(this.transloco.translate('transfer.pickFailed'));
        },
      );
      return;
    }
    this.imagePickerBinding = binding;
    this.attachInput()?.nativeElement.click();
  }
  onAttachChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    // The opening scope's validity is the only gate: unbind aborts it before a
    // successor can bind, so no identity comparison is needed.
    if (
      this.imagePickerBinding &&
      !this.imagePickerBinding.signal.aborted &&
      input.files &&
      input.files.length > 0
    )
      this.send.emit({
        kind: 'image',
        files: Array.from(input.files),
      });
    input.value = ''; // reset so the same file can be picked again
  }

  onFileClick(): void {
    const binding = this.boundContext;
    if (!binding || binding.signal.aborted) return;
    if (this.nativeUploads.supported()) {
      void this.nativeUploads.pick('file').then(
        (files) => {
          if (binding.signal.aborted) return;
          if (files.length) this.send.emit({ kind: 'native-files', files });
        },
        () => {
          if (!binding.signal.aborted)
            this.toast.warn(this.transloco.translate('transfer.pickFailed'));
        },
      );
      return;
    }
    this.filePickerBinding = binding;
    this.fileInput()?.nativeElement.click();
  }
  onFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (
      this.filePickerBinding &&
      !this.filePickerBinding.signal.aborted &&
      input.files &&
      input.files.length > 0
    )
      this.send.emit({
        kind: 'file',
        files: Array.from(input.files),
      });
    input.value = '';
  }

  // ── Attachment tray (Photo / File) ─────────────────────────────────────────────────────────────

  /** Whether the attachment action mode is covering the visible editor capsule. */
  readonly attachOpen = signal(false);
  readonly attachEntries = [
    {
      kind: 'action',
      key: 'photo',
      labelKey: 'chat.sendPhoto',
      icon: AppIconType.IMAGE,
    },
    {
      kind: 'action',
      key: 'file',
      labelKey: 'chat.sendFile',
      icon: AppIconType.FILE,
    },
    {
      kind: 'action',
      key: 'contact',
      labelKey: 'contactCard.send',
      icon: AppIconType.FRIEND_REQUESTS,
    },
  ] as const;

  toggleAttach(): void {
    const opening = !this.attachOpen();
    this.closeEmoji();
    if (opening) {
      this.editor()?.blur();
      this.keyboardInset.setVisible(false);
    }
    this.attachOpen.set(opening);
  }
  closeAttach(): void {
    this.attachOpen.set(false);
  }
  /** A drawer item was chosen → open the matching picker + close. */
  onAttachSelect(key: string): void {
    this.attachOpen.set(false);
    if (key === 'photo') this.onAttachClick();
    else if (key === 'file') this.onFileClick();
    else if (key === 'contact')
      this.route.popupDlg(PopupType.CONTACT_PICKER, undefined, (result) => {
        if (result) this.send.emit({ kind: 'contact', ...result });
      });
  }

  /** Blank attachment-cover space behaves like an outside click; action buttons retain their own handling. */
  onAttachDrawerClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.ci-attach-option'))
      this.closeAttach();
  }

  // ── Voice recording (press-hold mic) ───────────────────────────────────────────────────────────
  // The empty-draft send key becomes a mic; press-hold records (≤ MAX_RECORD_SECS), release sends, slide
  // up cancels. Pointer capture keeps move/up events on the mic element so the slide tracks reliably. The
  // audio Blob + duration are emitted as a ChatSendIntent; the host owns upload + optimistic insert.

  /** True while a recording is in flight (drives the overlay + the mic button state). */
  readonly recording = signal(false);
  /** Elapsed whole seconds (drives the timer label); resets each press. */
  readonly recordSecs = signal(0);
  /** True when the finger has slid up past the cancel threshold (release will discard). */
  readonly recordCancelled = signal(false);
  /** Recent analyser samples are appended at the right, so the live waveform travels right-to-left. */
  readonly recordWave = signal<number[]>(Array(28).fill(0.08));
  /** A transient error i18n KEY (permission denied / unsupported) shown above the bar; '' ⇒ none. Holds a
   *  transloco key — the template renders `{{ recordError() | transloco }}` — never the literal text. */
  readonly recordError = signal('');
  /** `m:ss` timer label. */
  readonly recordTimeLabel = computed(() => {
    const s = Math.min(MAX_RECORD_SECS, this.recordSecs());
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  });

  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private microphone?: Subscription;
  private mimeForRecording = '';
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private waveFrame?: number;
  private recordStartedAt = 0;
  /** The 60s cap stops MediaRecorder, but the gesture stays live until pointerup decides send vs discard. */
  private captureStoppedAtCap = false;
  private recorderStopSettled = false;
  private finishRequested = false;
  private tickTimer?: ReturnType<typeof setInterval>;
  private capTimer?: ReturnType<typeof setTimeout>;
  private errorTimer?: ReturnType<typeof setTimeout>;
  private recordHoldTimer?: ReturnType<typeof setTimeout>;
  private suppressSendResetTimer?: ReturnType<typeof setTimeout>;
  private recordHoldPending = false;
  private recordPressStartedWithDraft = false;
  private suppressNextSendClick = false;

  /** A deliberate hold starts voice recording while a short tap keeps the normal send behavior. Pointer
   *  capture keeps the whole gesture on this control even after the composer changes state or the finger moves
   *  into the cancel target. */
  onMicPointerDown(event: PointerEvent): void {
    if (this.sending() || this.recording()) return;
    event.preventDefault();
    const el = event.currentTarget as HTMLElement;
    // Capture before closing a keyboard: that layout change can move the button under the stationary
    // finger, but the active recording gesture must continue receiving move/up events.
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort */
    }
    this.recordPressStartedWithDraft = Boolean(this.draftHtml());
    this.recordHoldPending = true;
    clearTimeout(this.recordHoldTimer);
    this.recordHoldTimer = setTimeout(() => {
      this.recordHoldPending = false;
      this.activateRecordingGesture(el);
    }, RECORD_HOLD_DELAY_MS);
  }

  private activateRecordingGesture(el: HTMLElement): void {
    // Voice recording is not a text-editing state: close the IME and ensure the touch target itself
    // cannot retain focus. This also prevents Android from restoring the keyboard during mic permission.
    this.closeEmoji();
    this.closeAttach();
    this.editor()?.blur();
    this.keyboardInset.setVisible(false);
    el.blur();
    this.startRecording();
  }

  private startRecording(): void {
    this.stopRecording(true);
    this.recordCancelled.set(false);
    this.recordError.set('');
    this.beginRecording();
  }

  private beginRecording(): void {
    const mime = pickRecorderMime();
    if (
      !mime ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      this.flashRecordError('chat.recordMicUnsupported');
      return;
    }
    this.microphone = microphoneStream().subscribe({
      next: (stream) => this.beginCapture(stream, mime),
      error: () => this.flashRecordError('chat.recordMicDenied'),
    });
  }

  private beginCapture(stream: MediaStream, mime: string): void {
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime });
    } catch {
      this.stopRecording(true);
      this.flashRecordError('chat.recordMicUnsupported');
      return;
    }
    this.mimeForRecording = mime;
    this.chunks = [];
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.chunks.push(ev.data);
    };
    rec.onstop = () => {
      this.recorderStopSettled = true;
      if (this.finishRequested) this.finalizeRecording();
    };
    this.recorder = rec;
    this.recordStartedAt = Date.now();
    this.captureStoppedAtCap = false;
    this.recorderStopSettled = false;
    this.finishRequested = false;
    this.recordSecs.set(0);
    this.recording.set(true);
    try {
      rec.start();
    } catch {
      this.stopRecording(true);
      return;
    }
    this.startWaveform(stream);
    this.tickTimer = setInterval(() => {
      this.recordSecs.set(
        Math.min(
          MAX_RECORD_SECS,
          Math.floor((Date.now() - this.recordStartedAt) / 1000),
        ),
      );
    }, 250);
    this.capTimer = setTimeout(
      () => this.stopCaptureAtCap(),
      MAX_RECORD_SECS * 1000,
    );
  }

  /** Stop collecting bytes at 60s without deciding the gesture. The held finger can still slide between
   *  send and cancel; pointerup makes the final decision. */
  private stopCaptureAtCap(): void {
    const rec = this.recorder;
    if (!rec || !this.recording()) return;
    clearInterval(this.tickTimer);
    this.recordSecs.set(MAX_RECORD_SECS);
    this.captureStoppedAtCap = true;
    this.microphone?.unsubscribe();
    this.microphone = undefined;
    if (rec.state !== 'inactive') rec.stop();
  }

  /** Track the slide-up gesture (pointer capture keeps these arriving on the mic element). */
  onMicPointerMove(event: PointerEvent): void {
    if (!this.recording()) return;
    this.recordCancelled.set(this.isInsideRecordCancelTarget(event));
  }

  /** Release → send unless the gesture slid into cancel territory. */
  onMicPointerUp(event: PointerEvent): void {
    event.preventDefault();
    if (this.recordHoldPending) {
      clearTimeout(this.recordHoldTimer);
      this.recordHoldPending = false;
      this.recordPressStartedWithDraft = false;
      if (!this.sending() && this.draftHtml()) this.sendText();
      return;
    }
    if (this.recordPressStartedWithDraft) this.suppressNextPointerClick();
    this.recordPressStartedWithDraft = false;
    if (!this.recording()) {
      this.stopRecording(true);
      return;
    }
    const cancel = this.isInsideRecordCancelTarget(event);
    this.recordCancelled.set(cancel);
    void this.stopRecording(cancel);
  }

  /** System interrupt (scroll / IME / etc.) → always cancel. */
  onMicPointerCancel(): void {
    clearTimeout(this.recordHoldTimer);
    this.recordHoldPending = false;
    if (this.recordPressStartedWithDraft) this.suppressNextPointerClick();
    this.recordPressStartedWithDraft = false;
    this.stopRecording(true);
  }

  private suppressNextPointerClick(): void {
    this.suppressNextSendClick = true;
    clearTimeout(this.suppressSendResetTimer);
    this.suppressSendResetTimer = setTimeout(() => {
      this.suppressNextSendClick = false;
    }, 0);
  }

  /** The visible target is intentionally smaller than its gesture hit area for comfortable thumb input. */
  private isInsideRecordCancelTarget(event: PointerEvent): boolean {
    const target = this.recordCancelTarget()?.nativeElement;
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const tolerance = 14;
    return (
      event.clientX >= rect.left - tolerance &&
      event.clientX <= rect.right + tolerance &&
      event.clientY >= rect.top - tolerance &&
      event.clientY <= rect.bottom + tolerance
    );
  }

  private stopRecording(cancel: boolean): void {
    clearTimeout(this.recordHoldTimer);
    this.recordHoldPending = false;
    this.recordPressStartedWithDraft = false;
    clearTimeout(this.capTimer);
    clearInterval(this.tickTimer);
    this.recording.set(false);
    this.stopWaveform();
    const rec = this.recorder;
    if (cancel) {
      // Detach before stop: its queued final data/stop events must not reach a
      // successor recording or submit a clip after unbind.
      this.recorder = null;
      if (rec) {
        rec.ondataavailable = null;
        rec.onstop = null;
      }
      this.chunks = [];
      this.finishRequested = false;
      this.captureStoppedAtCap = false;
      this.recorderStopSettled = false;
    }
    this.microphone?.unsubscribe();
    this.microphone = undefined;
    if (!rec) return;
    if (cancel) {
      if (rec.state !== 'inactive') rec.stop();
      return;
    }
    this.finishRequested = true;
    if (rec.state !== 'inactive') {
      rec.stop(); // fires onstop → finalizeRecording
    } else if (this.recorderStopSettled) {
      this.finalizeRecording();
    }
  }

  /** MediaRecorder.stop() resolved → build the Blob and emit (or discard on cancel / too-short). */
  private finalizeRecording(): void {
    if (!this.recorder) return;
    this.recorder.ondataavailable = null;
    this.recorder.onstop = null;
    this.recorder = null;
    this.finishRequested = false;
    const durationMs = this.captureStoppedAtCap
      ? MAX_RECORD_SECS * 1000
      : Date.now() - this.recordStartedAt;
    this.captureStoppedAtCap = false;
    const chunks = this.chunks;
    this.chunks = [];
    const mime = this.mimeForRecording;
    if (isVoiceRecordingTooShort(durationMs)) {
      this.flashRecordError('chat.recordTooShort');
      return;
    }
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, {
      type: mime || chunks[0].type || 'audio/webm',
    });
    const duration = Math.max(1, Math.round(durationMs / 1000));
    this.send.emit({ kind: 'audio', blob, duration, mimeType: blob.type });
  }

  private flashRecordError(key: string): void {
    this.recordError.set(key);
    clearTimeout(this.errorTimer);
    clearTimeout(this.recordHoldTimer);
    clearTimeout(this.suppressSendResetTimer);
    this.errorTimer = setTimeout(() => this.recordError.set(''), 3000);
  }

  private startWaveform(stream: MediaStream): void {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      this.audioContext = context;
      this.analyser = analyser;
      const samples = new Uint8Array(analyser.fftSize);
      const draw = () => {
        if (!this.analyser || !this.recording()) return;
        analyser.getByteTimeDomainData(samples);
        let energy = 0;
        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          energy += normalized * normalized;
        }
        const level = Math.min(
          1,
          Math.max(0.08, Math.sqrt(energy / samples.length) * 4),
        );
        this.recordWave.update((wave) => [...wave.slice(1), level]);
        this.waveFrame = requestAnimationFrame(draw);
      };
      draw();
    } catch {
      // Recording remains functional when an engine exposes MediaRecorder but not Web Audio.
    }
  }

  private stopWaveform(): void {
    if (this.waveFrame !== undefined) cancelAnimationFrame(this.waveFrame);
    this.waveFrame = undefined;
    this.analyser = null;
    const context = this.audioContext;
    this.audioContext = null;
    if (context) void context.close().catch(() => {});
    this.recordWave.set(Array(28).fill(0.08));
  }

  /** Release conversation work without destroying the editor infrastructure. */
  unbind(): void {
    this.saveDraft();
    this.closeGenerationDialog();
    this.imagePickerBinding = undefined;
    this.filePickerBinding = undefined;
    this.boundContext = undefined;
    this.restoredThreadId = undefined;
    this.stopRecording(true);
    clearTimeout(this.errorTimer);
    clearTimeout(this.linkTimer);
    this.generationRequest?.unsubscribe();
    this.generationRequest = undefined;
    clearTimeout(this.recordHoldTimer);
    clearTimeout(this.suppressSendResetTimer);
    const generationId = this.generationId();
    if (generationId) this.generations.pause(generationId);
    this.generationId.set(null);
    this.generationStarting.set(false);
    this.generationStartFailed.set(false);
    this.generationTriggered = false;
    this.closeEmoji();
    this.closeAttach();
    this.editor()?.clear();
    this.draftHtml.set('');
    this.pendingLinkUrl = null;
    this.detectedLink.set(null);
  }

  ngOnDestroy(): void {
    this.unbind();
  }

  /** Move-to-front, dedup, cap at {@link RECENTS_MAX}; persist. */
  private pushRecent(e: string): void {
    const next = [e, ...this.recents().filter((x) => x !== e)].slice(
      0,
      RECENTS_MAX,
    );
    this.recents.set(next);
    this.recentsWriteRevision++;
    void this.preferences.set('device', RECENTS_KEY, next).catch(() => {});
  }

  private async restoreRecents(): Promise<void> {
    const revision = this.recentsWriteRevision;
    const stored = await this.preferences.get<unknown>('device', RECENTS_KEY);
    if (revision !== this.recentsWriteRevision) return;
    if (!Array.isArray(stored)) return;
    const values = stored.filter(
      (value): value is string => typeof value === 'string',
    );
    this.recents.set(values.slice(0, RECENTS_MAX));
    if (values.length > 0 && !this.activeCategory())
      this.activeCategory.set('recent');
  }
}
