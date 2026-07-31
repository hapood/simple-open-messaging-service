import {
  Component,
  ChangeDetectionStrategy,
  ViewEncapsulation,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import { TranslocoModule } from '@jsverse/transloco';
import {
  ChatEditorComponent,
  type ChatMember,
} from '../../components/chat-editor/chat-editor.component';
import {
  ChatActionMenuComponent,
  type ChatMenuEntry,
} from '../../components/chat-action-menu/chat-action-menu.component';
import { AppIconType } from '../../components/icon/icon.component';
import { PreventFocusStealDirective } from '../../directives/prevent-focus-steal.directive';
import { EMOJI_CATEGORIES } from './emoji-data';
import { firstValueFrom } from 'rxjs';
import { MsgService } from '../../services/message.service';
import { InputDeviceService } from '../../services/input-device.service';
import { KeyboardInsetService } from '../../services/keyboard-inset.service';
import {
  NativeUploadService,
  type NativeUploadSelection,
} from '../../services/native-upload.service';
import { uuid } from '../uuid';
import {
  PastePanelComponent,
  type PastePanelItem,
} from './paste-panel.component';
import {
  isVoiceRecordingTooShort,
  nextVoiceCancelState,
} from './voice-recording-state';
import { escapePlainText } from '../message-entity';

/**
 * A structured send intent emitted by {@link ChatInputComponent}. One discriminated union (rather than three
 * separate outputs) so the parent subscribes once and chronological order is preserved across rapid sends,
 * and so the parent's switch is exhaustive (TS forces handling every kind). The component never dispatches —
 * it only reports what the user wants to send; the host owns the optimistic-insert + HTTP/reconcile logic.
 */
export type ChatSendIntent =
  | { kind: 'text'; text: string }
  | { kind: 'image'; files: FileList }
  | { kind: 'file'; files: FileList }
  | { kind: 'native-files'; files: readonly NativeUploadSelection[] }
  | { kind: 'link'; url: string }
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

/** A single bare http(s) URL with no surrounding whitespace — the trigger for sending a link card rather
 *  than plain text. The server's LinkPreviewService builds the OG preview; the composer only classifies
 *  the intent (it never fetches). Anything else — prose, a URL mixed with text, multiple URLs — stays
 *  plain text so partial input is never surprising-converted into a card. */
const BARE_URL_RE = /^https?:\/\/\S+$/i;
function isBareUrl(text: string): boolean {
  return BARE_URL_RE.test(text);
}

/** A live link-card preview (server-built OG card) shown above the input bar while the draft is a
 *  single bare URL. `image` is a base64 data URI (inlined on the wire). */
interface LinkCardPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
}

/** Pick the best audio MIME the current browser can RECORD. MediaRecorder output varies by engine:
 *  Chrome / Android WebView / Tauri webview2 / webkit2gtk → audio/webm (opus); Safari / iOS / macOS
 *  wkwebview → audio/mp4; Firefox → audio/ogg (opus). The backend's /upload/audio accepts all of these
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

/** Hard cap on a single voice clip (seconds). On reach, recording auto-stops and sends. */
const MAX_RECORD_SECS = 60;
/** Load the persisted recents list (SSR/private-mode safe). */
function loadRecents(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === 'string')
      : [];
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
 *  - Emits {@link ChatSendIntent} on send; the host does the rest. Composer geometry is fixed by the global
 *    width policy, so typing never schedules a layout measurement here.
 *
 * Emoji panel: a WhatsApp/Telegram-style category grid with persisted Recents. Browser/PWA and desktop use
 * a floating panel without controlling the system keyboard. The Android native shell renders the same grid
 * in-flow as a keyboard replacement and uses one atomic native IME visibility capability.
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
  imports: [
    ChatEditorComponent,
    PreventFocusStealDirective,
    ChatActionMenuComponent,
    PastePanelComponent,
    OverlayModule,
    TranslocoModule,
  ],
  templateUrl: './chat-input.component.html',
  styleUrl: './chat-input.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
})
export class ChatInputComponent implements OnDestroy {
  private readonly nativeUploads = inject(NativeUploadService);
  /** @mention candidates (playground: mock; production group: member roster; production 1-on-1: []). Read into
   *  the editor; updates do NOT recreate the editor. */
  readonly members = input<ChatMember[]>([]);
  readonly placeholder = input('');
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
  private readonly msgService = inject(MsgService);
  private readonly inputDevice = inject(InputDeviceService);
  readonly desktopRecordingControls = this.inputDevice.hasPhysicalKeyboard;
  private readonly keyboardInset = inject(KeyboardInsetService);

  /** The editor's current inline HTML — used only for the send-button enabled state (empty editor ⇒ ''). The
   *  actual text payload is read via `editor.getText()` at send time. */
  readonly draftHtml = signal('');
  /** Browser/desktop emoji remains a simple floating popup. Android uses its native composer instead. */
  readonly emojiOpen = signal(false);
  /** Live link-card preview when the draft is a single bare URL (WeChat/WhatsApp-style; built
   *  server-side). Null when the draft isn't a bare URL or the fetch hasn't landed yet. The send path
   *  reuses the server's cache so the sent card builds instantly. */
  readonly previewCard = signal<LinkCardPreview | null>(null);
  /** Ephemeral paste review state. This relationship is deliberately UI-only: confirmed entries become
   *  ordinary independent messages and no batch identifier reaches the API. */
  readonly pasteItems = signal<PastePanelItem[]>([]);
  readonly pasteText = signal('');
  readonly pasteOpen = signal(false);
  /** Monotonic token: a slow earlier URL's response must not overwrite a newer edit's preview. */
  private previewSeq = 0;
  private previewTimer?: ReturnType<typeof setTimeout>;

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
      ? [{ id: 'recent', icon: '🕐', icons: rec }]
      : [];
    const categoryTabs = EMOJI_CATEGORIES.map((c) => ({
      id: c.id,
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
    const btn = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-emoji]',
    );
    if (btn) this.insertEmoji(btn.dataset['emoji']!);
  }

  // Editor content changed: track draft (send-button state); excess lines scroll inside the fixed editor.
  onHtml(h: string): void {
    this.draftHtml.set(h);
    this.scheduleLinkPreview();
  }

  /** A clipboard payload containing files belongs in the roomy review panel, not in the compact editor.
   *  The editor has already prevented its default insertion before calling this method. */
  onAttachmentPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (!data) return;
    this.appendPaste(Array.from(data.files), data.getData('text/plain'));
  }

  appendPanelPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    if (!data) return;
    this.appendPaste(Array.from(data.files), data.getData('text/plain'));
  }

  private appendPaste(files: readonly File[], text: string): void {
    if (files.length === 0) return;
    const existing = new Set(
      this.pasteItems().map(({ file }) => this.fileFingerprint(file)),
    );
    const additions: PastePanelItem[] = [];
    for (const file of files) {
      const fingerprint = this.fileFingerprint(file);
      if (existing.has(fingerprint)) continue;
      existing.add(fingerprint);
      additions.push({
        id: `${fingerprint}:${uuid()}`,
        file,
        previewUrl: file.type.startsWith('image/')
          ? URL.createObjectURL(file)
          : undefined,
      });
    }
    this.pasteItems.update((items) => [...items, ...additions]);
    if (text) {
      this.pasteText.update((current) =>
        current ? `${current}\n${text}` : text,
      );
    }
    this.closeEmoji();
    this.closeAttach();
    this.pasteOpen.set(true);
  }

  removePasteItem(id: string): void {
    const item = this.pasteItems().find((candidate) => candidate.id === id);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    this.pasteItems.update((items) =>
      items.filter((candidate) => candidate.id !== id),
    );
  }

  cancelPaste(): void {
    this.clearPasteState();
  }

  confirmPaste(): void {
    const files = this.pasteItems().map(({ file }) => file);
    const text = this.pasteText().trim();
    if (files.length === 0 && !text) return;
    this.clearPasteState();
    this.send.emit({ kind: 'paste', text: escapePlainText(text), files });
  }

  private clearPasteState(): void {
    for (const item of this.pasteItems()) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    this.pasteItems.set([]);
    this.pasteText.set('');
    this.pasteOpen.set(false);
  }

  private fileFingerprint(file: File): string {
    return `${file.name}:${file.type}:${file.size}:${file.lastModified}`;
  }

  /** Debounce: 400ms after the draft stops changing, if it is a single bare URL, ask the server to
   *  build the card and show it above the bar; any non-URL draft clears the preview. The user sees the
   *  card BEFORE they send (WeChat/WhatsApp flow). */
  private scheduleLinkPreview(): void {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => void this.fetchPreview(), 400);
  }

  private async fetchPreview(): Promise<void> {
    const editor = this.editor();
    const text = editor ? editor.getText().trim() : '';
    if (!isBareUrl(text)) {
      this.previewCard.set(null);
      return;
    }
    const seq = ++this.previewSeq;
    try {
      const res = (await firstValueFrom(this.msgService.previewLink(text))) as {
        code: number;
        data?: LinkCardPreview;
      };
      if (seq !== this.previewSeq) return; // superseded by a newer edit — drop the stale response
      if (res.code === 0 && res.data) this.previewCard.set(res.data);
    } catch {
      // network error → leave the preview as-is; never block composing
    }
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

  /** Close the emoji surface when interaction leaves the composer. The form contains the input, emoji
   *  toggle, category buttons and glyphs, so browser emoji interactions remain exempt and keep the IME. */
  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.emojiOpen()) return;
    const target = event.target;
    if (
      !(target instanceof Node) ||
      !this.inputBar()?.nativeElement.contains(target)
    ) {
      this.closeEmoji();
    }
  }

  /** Send key: draft present → send text. On pointer-accurate devices the empty mic toggles recording on
   *  successive clicks; touch/pen keep the press-hold gesture handled by the pointer callbacks below. */
  onSendClick(): void {
    if (this.sending()) return;
    if (this.draftHtml()) {
      this.sendText();
      return;
    }
    // A completed touch/pen gesture produces a compatibility click after pointerup. Its recording has
    // already been stopped (and normally sent) there, so consuming that click prevents an immediate,
    // surprising second recording from starting.
    if (this.suppressNextMicClick) {
      this.suppressNextMicClick = false;
      return;
    }
    if (this.recording()) {
      void this.stopRecording(false);
      return;
    }
    this.startRecording();
  }

  /** Desktop recording has explicit actions because mouse users should not need to discover a drag gesture. */
  sendDesktopRecording(): void {
    if (this.recording()) void this.stopRecording(false);
  }

  cancelDesktopRecording(): void {
    if (this.recording()) void this.stopRecording(true);
  }

  @HostListener('document:keydown.escape')
  cancelDesktopRecordingWithEscape(): void {
    if (this.desktopRecordingControls() && this.recording()) {
      this.cancelDesktopRecording();
    }
  }

  /** Desktop Enter (the editor's `send` output): same as the text branch of the send key. */
  onEditorSend(): void {
    if (this.sending()) return;
    this.sendText();
  }

  private sendText(): void {
    const editor = this.editor();
    if (!editor) return;
    const displayText = editor.getText().trim();
    if (!displayText) return;
    const storageText = editor.getStorageText().trim();
    editor.clear();
    this.draftHtml.set('');
    this.previewCard.set(null);
    clearTimeout(this.previewTimer);
    this.closeEmoji();
    this.closeAttach();
    this.send.emit(
      isBareUrl(displayText)
        ? { kind: 'link', url: displayText }
        : { kind: 'text', text: storageText },
    );
  }

  onAttachClick(): void {
    if (this.nativeUploads.supported()) {
      void this.nativeUploads.pick('image').then((files) => {
        if (files.length) this.send.emit({ kind: 'native-files', files });
      });
      return;
    }
    this.attachInput()?.nativeElement.click();
  }
  onAttachChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0)
      this.send.emit({ kind: 'image', files: input.files });
    input.value = ''; // reset so the same file can be picked again
  }

  onFileClick(): void {
    if (this.nativeUploads.supported()) {
      void this.nativeUploads.pick('file').then((files) => {
        if (files.length) this.send.emit({ kind: 'native-files', files });
      });
      return;
    }
    this.fileInput()?.nativeElement.click();
  }
  onFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0)
      this.send.emit({ kind: 'file', files: input.files });
    input.value = '';
  }

  // ── Attachment "+" popover (Photo / File) ──────────────────────────────────────────────────────

  /** Whether the attachment action menu overlay is open. */
  readonly attachOpen = signal(false);
  /** The popover entries — Photo (image picker) + File (generic picker). Mirrors the header MORE menu's
   *  ChatActionMenuComponent usage; ChatActionMenuComponent renders labels via labelKey (transloco). */
  readonly attachEntries: ChatMenuEntry[] = [
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
  ];
  /** The composer sits at the viewport bottom, so prefer opening upward. This also keeps the file/photo
   *  choices visible after the touch keyboard is dismissed. */
  readonly attachPositions: ConnectedPosition[] = [
    {
      originX: 'start',
      originY: 'top',
      overlayX: 'start',
      overlayY: 'bottom',
      offsetY: -4,
    },
    {
      originX: 'end',
      originY: 'top',
      overlayX: 'end',
      overlayY: 'bottom',
      offsetY: -4,
    },
    {
      originX: 'start',
      originY: 'bottom',
      overlayX: 'start',
      overlayY: 'top',
      offsetY: 4,
    },
  ];

  toggleAttach(): void {
    const opening = !this.attachOpen();
    this.closeEmoji();
    if (opening && !this.inputDevice.hasPhysicalKeyboard())
      this.editor()?.blur();
    this.attachOpen.set(opening);
  }
  closeAttach(): void {
    this.attachOpen.set(false);
  }
  /** A popover item was chosen → open the matching picker + close. */
  onAttachSelect(key: string): void {
    this.attachOpen.set(false);
    if (key === 'photo') this.onAttachClick();
    else if (key === 'file') this.onFileClick();
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
  private stream: MediaStream | null = null;
  private mimeForRecording = '';
  private pointerStartY = 0;
  /** Touch/pen pointerup is followed by a synthetic click; consume it after the hold gesture completes. */
  private suppressNextMicClick = false;
  private recordStartedAt = 0;
  private pendingCancel = false;
  /** The 60s cap stops MediaRecorder, but the gesture stays live until pointerup decides send vs discard. */
  private captureStoppedAtCap = false;
  private recorderStopSettled = false;
  private finishRequested = false;
  /** Generation counter for the in-flight press — bumped on every pointerdown/up/cancel/destroy. beginRecording
   *  is async (blocked on the getUserMedia permission prompt, which can take seconds); it captures the session
   *  at start and re-checks it after every await, so a press that ended (or a component that died) while the
   *  prompt was up is detected and the mic is released without starting a stray recorder. A boolean "aborted"
   *  flag could not cover the sub-millisecond window between the post-await check and MediaRecorder.start(). */
  private recordSession = 0;
  /** True once ngOnDestroy ran — beginRecording checks it so a permission prompt resolved after teardown
   *  (thread switch mid-grant) never starts a recorder on a dead view. */
  private destroyed = false;
  private tickTimer?: ReturnType<typeof setInterval>;
  private capTimer?: ReturnType<typeof setTimeout>;
  private errorTimer?: ReturnType<typeof setTimeout>;

  /** Press-hold start. Only the empty-draft state renders the mic, so this runs only then. Pointer capture
   *  is taken synchronously so move/up keep arriving even as the finger roams (slide-to-cancel); the async
   *  getUserMedia/MediaRecorder.start() follow, and recordAborted short-circuits a gesture that already ended. */
  onMicPointerDown(event: PointerEvent): void {
    if (this.sending() || this.draftHtml() || this.recording()) return;
    // Mouse users expect a button click, not a press-and-hold gesture. Let the subsequent click toggle
    // recording; touch and pen retain hold/release/slide-to-cancel semantics.
    if (event.pointerType === 'mouse') {
      this.suppressNextMicClick = false;
      return;
    }
    event.preventDefault();
    this.suppressNextMicClick = true;
    const el = event.currentTarget as HTMLElement;
    // Capture before closing a keyboard: that layout change can move the button under the stationary
    // finger, but the active recording gesture must continue receiving move/up events.
    try {
      el.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort */
    }
    // Voice recording is not a text-editing state: close the IME and ensure the touch target itself
    // cannot retain focus. This also prevents Android from restoring the keyboard during mic permission.
    this.closeEmoji();
    this.editor()?.blur();
    this.keyboardInset.setVisible(false);
    el.blur();
    this.pointerStartY = event.clientY;
    this.startRecording();
  }

  private startRecording(): void {
    this.recordSession++; // a fresh press invalidates any in-flight beginRecording
    this.recordCancelled.set(false);
    this.recordError.set('');
    void this.beginRecording(this.recordSession);
  }

  private async beginRecording(session: number): Promise<void> {
    const mime = pickRecorderMime();
    if (
      !mime ||
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      this.flashRecordError('chat.recordMicUnsupported');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.flashRecordError('chat.recordMicDenied');
      return;
    }
    // The gesture ended (released/cancelled) or the component was destroyed while the permission prompt was
    // up — release the mic and bail. The session counter (bumped on every gesture end) is the race-free
    // signal that THIS press is still the live one.
    if (this.recordSession !== session || this.destroyed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    this.mimeForRecording = mime;
    const rec = new MediaRecorder(stream, { mimeType: mime });
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
      // start() can throw if the stream was stopped concurrently — bail without emitting.
      this.recorder = null;
      this.recording.set(false);
      stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      return;
    }
    // Close the remaining race: the gesture may have ended in the window between the post-await check above
    // and rec.start(). If so, stop+discard now rather than running unattended until the 60s cap.
    if (this.recordSession !== session || this.destroyed) {
      void this.stopRecording(true);
      return;
    }
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (rec.state !== 'inactive') rec.stop();
  }

  /** Track the slide-up gesture (pointer capture keeps these arriving on the mic element). */
  onMicPointerMove(event: PointerEvent): void {
    if (event.pointerType === 'mouse') return;
    if (!this.recording()) return;
    this.recordCancelled.set(
      nextVoiceCancelState(
        this.recordCancelled(),
        this.pointerStartY - event.clientY,
      ),
    );
  }

  /** Release → send unless the gesture slid into cancel territory. */
  onMicPointerUp(event: PointerEvent): void {
    if (event.pointerType === 'mouse') return;
    event.preventDefault();
    if (!this.recording()) {
      this.recordSession++;
      return;
    } // ended before start → invalidate the in-flight begin
    void this.stopRecording(this.recordCancelled());
  }

  /** System interrupt (scroll / IME / etc.) → always cancel. */
  onMicPointerCancel(): void {
    if (!this.recording()) {
      this.recordSession++;
      return;
    } // ended before start → invalidate the in-flight begin
    void this.stopRecording(true);
  }

  private stopRecording(cancel: boolean): void {
    const rec = this.recorder;
    if (!rec) return;
    clearTimeout(this.capTimer);
    clearInterval(this.tickTimer);
    this.pendingCancel = cancel;
    this.finishRequested = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.recording.set(false);
    if (rec.state !== 'inactive') {
      rec.stop(); // fires onstop → finalizeRecording
    } else if (this.recorderStopSettled) {
      this.finalizeRecording();
    }
  }

  /** MediaRecorder.stop() resolved → build the Blob and emit (or discard on cancel / too-short). */
  private finalizeRecording(): void {
    if (!this.recorder) return;
    this.recorder = null;
    this.finishRequested = false;
    const cancel = this.pendingCancel;
    this.pendingCancel = false;
    const durationMs = this.captureStoppedAtCap
      ? MAX_RECORD_SECS * 1000
      : Date.now() - this.recordStartedAt;
    this.captureStoppedAtCap = false;
    const chunks = this.chunks;
    this.chunks = [];
    const mime = this.mimeForRecording;
    if (cancel) return;
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
    this.errorTimer = setTimeout(() => this.recordError.set(''), 3000);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.clearPasteState();
    this.recordSession++; // invalidate any in-flight beginRecording (permission prompt resolved post-teardown)
    // Stop an in-flight recording if the component is torn down mid-press (thread switch, route leave, etc.).
    if (this.recorder) this.stopRecording(true);
    clearTimeout(this.capTimer);
    clearInterval(this.tickTimer);
    clearTimeout(this.errorTimer);
    clearTimeout(this.previewTimer);
  }

  /** Move-to-front, dedup, cap at {@link RECENTS_MAX}; persist. */
  private pushRecent(e: string): void {
    const next = [e, ...this.recents().filter((x) => x !== e)].slice(
      0,
      RECENTS_MAX,
    );
    this.recents.set(next);
    saveRecents(next);
  }
}
