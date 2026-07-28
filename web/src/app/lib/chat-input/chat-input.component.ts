import {
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
import { ConnectedPosition, OverlayModule } from '@angular/cdk/overlay';
import { TranslocoModule } from '@jsverse/transloco';
import { ChatEditorComponent, type ChatMember } from '../../components/chat-editor/chat-editor.component';
import { ChatActionMenuComponent, type ChatMenuEntry } from '../../components/chat-action-menu/chat-action-menu.component';
import { AppIconType } from '../../components/icon/icon.component';
import { PreventFocusStealDirective } from '../../directives/prevent-focus-steal.directive';
import { EMOJI_CATEGORIES } from './emoji-data';
import { firstValueFrom } from 'rxjs';
import { MsgService } from '../../services/message.service';
import { InputDeviceService } from '../../services/input-device.service';
import { KeyboardInsetService } from '../../services/keyboard-inset.service';
import { hideIme, showIme } from './native-ime';
import { isAndroidNative } from '../../services/runtime';
import {
  NativeUploadService,
  type NativeUploadSelection,
} from '../../services/native-upload.service';
import { uuid } from '../uuid';
import {
  PastePanelComponent,
  type PastePanelItem,
} from './paste-panel.component';

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

type KeyboardMode = 'closed' | 'toEmoji' | 'emoji' | 'toSystem';

const RECENTS_KEY = 'soms.chat.emojiRecents';
const RECENTS_MAX = 32;
// Android edge-to-edge builds can briefly report only the navigation/gesture inset as the IME height.
// That value is useful for neither the native-keyboard slot nor the emoji grid and would collapse the
// replacement panel to a thin strip. A real usable keyboard surface needs room for tabs plus several rows.
const MIN_EMOJI_KEYBOARD_HEIGHT = 240;

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
 *  (EBML/ftyp are shared audio/video containers — see consumeMedia's sharedAsAudio branch). Some older
 *  Android/OEM WebViews can record with the engine default while reporting false for every explicit MIME,
 *  so `undefined` means "let MediaRecorder choose"; `null` alone means the API is unavailable. */
function pickRecorderMime(): string | undefined | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      /* isTypeSupported can throw on an unknown MIME in some engines — skip it */
    }
  }
  return undefined;
}

/** Hard cap on a single voice clip (seconds). On reach, recording auto-stops and sends. */
const MAX_RECORD_SECS = 60;
/** Press-holds shorter than this (ms) are treated as an accidental tap and discarded. */
const MIN_RECORD_MS = 500;
/** Slide-up distance (px) beyond the press point that flips the gesture to "cancel". */
const CANCEL_SLIDE_PX = 48;

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
 * Emoji panel: a WhatsApp/Telegram-style category grid with persisted Recents. Browser/PWA and desktop use
 * a floating panel without controlling the system keyboard. The Android native shell renders the same grid
 * in-flow as a keyboard replacement and controls the IME exclusively through SomsShell.showIme/hideIme.
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
  /** The input bar's measured height (auto-grows with the editor); the host may bind its viewport bottom to it. */
  readonly heightChange = output<number>();

  private readonly editor = viewChild(ChatEditorComponent);
  private readonly inputBar = viewChild<ElementRef<HTMLFormElement>>('inputBar');
  private readonly attachInput = viewChild<ElementRef<HTMLInputElement>>('attachInput');
  private readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly msgService = inject(MsgService);
  private readonly inputDevice = inject(InputDeviceService);
  private readonly keyboardInset = inject(KeyboardInsetService);

  /** The editor's current inline HTML — used only for the send-button enabled state (empty editor ⇒ ''). The
   *  actual text payload is read via `editor.getText()` at send time. */
  readonly draftHtml = signal('');
  /** One authoritative keyboard-switch state. Derived view flags below cannot form illegal combinations. */
  private readonly keyboardMode = signal<KeyboardMode>('closed');
  readonly emojiOpen = computed(() => this.keyboardMode() === 'emoji');
  readonly emojiMounted = computed(() => this.keyboardMode() !== 'closed');
  /** Only the Android native shell has the reliable focus-preserving IME bridge required for a keyboard
   *  replacement. Desktop and mobile browsers both use the floating popup. */
  readonly emojiKeyboard = signal(isAndroidNative());
  /** Stable keyboard slot height. During a native↔emoji handoff the native inset and custom panel divide
   *  this height between them, keeping the composer at one constant Y position. */
  readonly emojiKeyboardHeight = signal(300);
  readonly keyboardHandoff = computed(() => {
    const mode = this.keyboardMode();
    return mode === 'toEmoji' || mode === 'toSystem';
  });
  readonly emojiPanelHeight = computed(() => {
    const stableHeight = this.emojiKeyboardHeight();
    return this.keyboardHandoff()
      ? Math.max(0, stableHeight - this.keyboardInset.inset())
      : stableHeight;
  });
  private readonly keyboardLayoutOwner = {};
  readonly switchingToSystem = computed(() => this.keyboardMode() === 'toSystem');
  private keyboardHandoffTimer?: ReturnType<typeof setTimeout>;
  private readonly trackKeyboardGeometry = effect(() => {
    const inset = this.keyboardInset.inset();
    const animationTarget = this.keyboardInset.animation()?.target;
    // When returning to the system keyboard, Android 11+ tells us its final height before the first
    // visible animation frame. Adopt that as the invariant slot immediately; the shrinking custom
    // residual can then meet the growing IME at the exact final input-bar position.
    if (
      this.keyboardMode() === 'toSystem' &&
      animationTarget !== undefined &&
      animationTarget > 0
    ) {
      this.emojiKeyboardHeight.set(Math.max(MIN_EMOJI_KEYBOARD_HEIGHT, animationTarget));
    }
    // Capture the stable slot only during ordinary native-keyboard use. Updating it during a handoff
    // would make both sides of `nativeInset + emojiResidual = stableHeight` shrink together.
    if (inset > 0 && this.keyboardMode() === 'closed') {
      this.emojiKeyboardHeight.set(Math.max(MIN_EMOJI_KEYBOARD_HEIGHT, inset));
    }
    if (this.keyboardMode() === 'toEmoji' && inset === 0) {
      requestAnimationFrame(() => {
        if (this.keyboardMode() !== 'toEmoji') return;
        this.keyboardMode.set('emoji');
        this.measureBar();
      });
    }
    if (this.switchingToSystem() && inset > 0) {
      // Do not unmount at the first animation frame (often 1–10px): the residual emoji height is what
      // keeps the slot full while the IME grows. Close only after geometry has settled briefly.
      clearTimeout(this.keyboardHandoffTimer);
      this.keyboardHandoffTimer = setTimeout(() => {
        this.keyboardMode.set('closed');
        this.keyboardInset.setLayoutOverride(this.keyboardLayoutOwner, null);
        this.measureBar();
      }, 80);
    }
  });
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
    const recentsTab: EmojiTab[] = rec.length ? [{ id: 'recent', icon: '🕐', icons: rec }] : [];
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
    const btn = (event.target as HTMLElement).closest<HTMLElement>('[data-emoji]');
    if (btn) this.insertEmoji(btn.dataset['emoji']!);
  }

  // Editor content changed: track draft (send-button state) + re-measure the bar (auto-grow ⇒ heightChange).
  onHtml(h: string): void {
    this.draftHtml.set(h);
    this.measureBar();
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
    this.pasteItems.update((items) => items.filter((candidate) => candidate.id !== id));
  }

  cancelPaste(): void {
    this.clearPasteState();
  }

  confirmPaste(): void {
    const files = this.pasteItems().map(({ file }) => file);
    const text = this.pasteText().trim();
    if (files.length === 0 && !text) return;
    this.clearPasteState();
    this.send.emit({ kind: 'paste', text, files });
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
    if (this.keyboardMode() !== 'closed') { this.closeEmoji(); return; }
    this.closeAttach();
    if (this.recents().length) this.activeCategory.set('recent');
    if (this.emojiKeyboard()) {
      const nativeKeyboardOpen = this.keyboardInset.inset() > 0;
      this.keyboardMode.set(nativeKeyboardOpen ? 'toEmoji' : 'emoji');
      // ProseMirror retains its selection while blurred. Releasing DOM focus makes hiding deterministic
      // on WebViews that immediately restore the IME for a focused contenteditable.
      this.editor()?.blur();
      // During handoff the custom residual owns only `stableHeight - nativeInset`; layout ignores the
      // native lift so the two surfaces add to one invariant slot instead of stacking at full height.
      this.keyboardInset.setLayoutOverride(this.keyboardLayoutOwner, 0);
      hideIme();
    } else {
      this.keyboardMode.set('emoji');
      this.editor()?.focus();
    }
    this.measureBar();
  }
  closeEmoji(): void {
    clearTimeout(this.keyboardHandoffTimer);
    this.keyboardMode.set('closed');
    this.keyboardInset.setLayoutOverride(this.keyboardLayoutOwner, null);
    this.measureBar();
  }
  /** Switch from the custom emoji keyboard back to normal typing. This explicit action is the only path
   *  that focuses the editor while the touch emoji surface is open. */
  showSystemKeyboard(): void {
    // Hide custom controls immediately, then let the native inset grow while the blank custom residual
    // shrinks by the same amount. Geometry overlaps; visible/interactive keyboard controls never do.
    this.keyboardMode.set('toSystem');
    this.editor()?.focus();
    if (!showIme()) this.closeEmoji();
    this.measureBar();
  }
  onEditorFocusChange(focused: boolean): void {
    if (!focused && (!this.emojiKeyboard() || this.keyboardMode() === 'closed')) {
      this.closeEmoji();
    }
  }
  /** Insert at the last editor selection and record it to Recents. Desktop refocuses the editor; the touch
   *  keyboard keeps it blurred so the native IME remains hidden. */
  insertEmoji(e: string): void {
    this.editor()?.insertText(e, !this.emojiKeyboard());
    this.pushRecent(e);
  }
  deleteEmojiInput(): void {
    this.editor()?.deleteBackward(!this.emojiKeyboard());
  }

  /** Close the emoji surface when interaction leaves the composer. The form contains the input, emoji
   *  toggle, category buttons and glyphs, so browser emoji interactions remain exempt and keep the IME. */
  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: PointerEvent): void {
    if (this.keyboardMode() === 'closed') return;
    const target = event.target;
    if (!(target instanceof Node) || !this.inputBar()?.nativeElement.contains(target)) {
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
    this.previewCard.set(null);
    clearTimeout(this.previewTimer);
    this.closeEmoji();
    this.closeAttach();
    this.measureBar();
    this.send.emit(isBareUrl(text) ? { kind: 'link', url: text } : { kind: 'text', text });
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
    if (input.files && input.files.length > 0) this.send.emit({ kind: 'image', files: input.files });
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
    if (input.files && input.files.length > 0) this.send.emit({ kind: 'file', files: input.files });
    input.value = '';
  }

  // ── Attachment "+" popover (Photo / File) ──────────────────────────────────────────────────────

  /** Whether the attachment action menu overlay is open. */
  readonly attachOpen = signal(false);
  /** The popover entries — Photo (image picker) + File (generic picker). Mirrors the header MORE menu's
   *  ChatActionMenuComponent usage; ChatActionMenuComponent renders labels via labelKey (transloco). */
  readonly attachEntries: ChatMenuEntry[] = [
    { kind: 'action', key: 'photo', labelKey: 'chat.sendPhoto', icon: AppIconType.IMAGE },
    { kind: 'action', key: 'file', labelKey: 'chat.sendFile', icon: AppIconType.FILE },
  ];
  /** The composer sits at the viewport bottom, so prefer opening upward. This also keeps the file/photo
   *  choices visible after the touch keyboard is dismissed. */
  readonly attachPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top', overlayX: 'start', overlayY: 'bottom', offsetY: -4 },
    { originX: 'end', originY: 'top', overlayX: 'end', overlayY: 'bottom', offsetY: -4 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top', offsetY: 4 },
  ];

  toggleAttach(): void {
    const opening = !this.attachOpen();
    this.closeEmoji();
    if (opening && !this.inputDevice.hasPhysicalKeyboard()) this.editor()?.blur();
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
    try { el.setPointerCapture(event.pointerId); } catch { /* capture is best-effort */ }
    // Voice recording is not a text-editing state: close the IME and ensure the touch target itself
    // cannot retain focus. This also prevents Android from restoring the keyboard during mic permission.
    this.closeEmoji();
    this.editor()?.blur();
    hideIme();
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
    if (mime === null || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
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
    this.mimeForRecording = mime ?? '';
    let rec: MediaRecorder;
    try {
      // An explicit MIME is preferable where the engine advertises one. Older Android/OEM WebViews often
      // reject every isTypeSupported probe but still record successfully when allowed to choose a default.
      rec = mime
        ? new MediaRecorder(stream, { mimeType: mime })
        : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
      this.flashRecordError('chat.recordMicUnsupported');
      return;
    }
    this.chunks = [];
    rec.ondataavailable = (ev) => { if (ev.data.size > 0) this.chunks.push(ev.data); };
    rec.onstop = () => this.finalizeRecording();
    this.recorder = rec;
    this.recordStartedAt = Date.now();
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
      this.recordSecs.set(Math.min(MAX_RECORD_SECS, Math.floor((Date.now() - this.recordStartedAt) / 1000)));
    }, 250);
    this.capTimer = setTimeout(() => this.stopRecording(false), MAX_RECORD_SECS * 1000);
  }

  /** Track the slide-up gesture (pointer capture keeps these arriving on the mic element). */
  onMicPointerMove(event: PointerEvent): void {
    if (event.pointerType === 'mouse') return;
    if (!this.recording()) return;
    this.recordCancelled.set(event.clientY - this.pointerStartY < -CANCEL_SLIDE_PX);
  }

  /** Release → send unless the gesture slid into cancel territory. */
  onMicPointerUp(event: PointerEvent): void {
    if (event.pointerType === 'mouse') return;
    event.preventDefault();
    if (!this.recording()) { this.recordSession++; return; } // ended before start → invalidate the in-flight begin
    void this.stopRecording(this.recordCancelled());
  }

  /** System interrupt (scroll / IME / etc.) → always cancel. */
  onMicPointerCancel(): void {
    if (!this.recording()) { this.recordSession++; return; } // ended before start → invalidate the in-flight begin
    void this.stopRecording(true);
  }

  private stopRecording(cancel: boolean): void {
    const rec = this.recorder;
    if (!rec) return;
    clearTimeout(this.capTimer);
    clearInterval(this.tickTimer);
    this.pendingCancel = cancel;
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (rec.state !== 'inactive') rec.stop(); // fires onstop → finalizeRecording
    this.recording.set(false);
  }

  /** MediaRecorder.stop() resolved → build the Blob and emit (or discard on cancel / too-short). */
  private finalizeRecording(): void {
    const cancel = this.pendingCancel;
    this.pendingCancel = false;
    const durationMs = Date.now() - this.recordStartedAt;
    const chunks = this.chunks;
    this.chunks = [];
    const mime = this.mimeForRecording;
    if (cancel || durationMs < MIN_RECORD_MS || chunks.length === 0) return;
    const blob = new Blob(chunks, { type: mime || chunks[0].type || 'audio/webm' });
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
    clearTimeout(this.keyboardHandoffTimer);
    this.keyboardInset.setLayoutOverride(this.keyboardLayoutOwner, null);
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
