import { Component, input, signal, computed, EventEmitter, Output, inject, OnInit, OnDestroy, ElementRef, effect } from '@angular/core';
import { NgClass } from '@angular/common';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService, PopupType } from '../../services/route.service'
import { ConversationListService, ConversationLoadStatus } from '../../services/conversation-list.service'
import { UserService } from '../../services/user.service'
import { ConversationItem, displayThreadName } from '../../services/model'
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { ChatFolder, inFolder } from '../../services/folder.service'
import { LanguageService } from '../../services/language.service'
import { formatListTime } from '../message-cards/date-format'
import { playFlipList, snapshotFlipRects } from '../../lib/flip-list'

/**
 * Conversation list view. A thin view over the shared ConversationListService (the client-side source
 * of truth, also driven by mark-read and realtime SSE). Folder + local-search filtering stay here as
 * computeds over the shared items; the active row is the store's openThreadId.
 */
@Component({
    selector: 'app-thread-list',
    imports: [UserAvatarComponent, IconComponent, NgClass, EmptyStateComponent, TranslocoPipe, FederatedBadgeComponent],
    templateUrl: './thread-list.component.html',
    styleUrl: './thread-list.component.scss'
})
export class ThreadListComponent implements OnInit, OnDestroy {
  readonly UserAvatarType = UserAvatarType
  /** exposes the icon enum to the template (mute indicator on muted threads). */
  readonly AppIconType = AppIconType
  /** active folder; undefined = no folder filter (show all) */
  readonly folder = input<ChatFolder | undefined>(undefined)
  /** local name search; '' = no filter. */
  readonly searchText = input('')

  private readonly routeService = inject(RouteService)
  private readonly convList = inject(ConversationListService)
  private readonly userService = inject(UserService)
  private readonly transloco = inject(TranslocoService)
  private readonly language = inject(LanguageService)
  private readonly host = inject(ElementRef)
  /** Last-known row rects — the "before" snapshot the next top-insert FLIPs against. Refreshed on
   *  every render that doesn't itself animate, so a later insert measures against current positions. */
  private prevRects = new Map<string, DOMRect>()

  /** Delay-gated shimmer skeleton (mirrors MessageThreadComponent). The rows stay hidden until an
   *  initial/retry load outlasts SKELETON_DELAY, so a fast load renders real rows directly with zero
   *  flash — only a genuinely slow load reveals the skeleton. */
  readonly skeletonVisible = signal(false)
  private skeletonTimer?: ReturnType<typeof setTimeout>
  private static readonly SKELETON_DELAY = 300

  constructor() {
    // FLIP list animation: re-runs whenever the shared list mutates (read items() reactively). The
    // rAF defers the rect read until the DOM has settled into the new layout; on a deliberate
    // top-insert (convList.topInserted pulse) it plays the enter + shift, otherwise it refreshes the
    // "before" snapshot so routine reloads / message bumps / filter changes keep the map current
    // without animating.
    effect(() => {
      this.convList.items()
      requestAnimationFrame(() => {
        const container = (this.host.nativeElement as HTMLElement | null)
          ?.querySelector('.thread-list') as HTMLElement | null
        if (!container) return
        const tid = this.convList.topInserted()
        if (tid != null) {
          this.prevRects = playFlipList(container, this.prevRects)
          this.convList.clearTopInserted()
        } else {
          this.prevRects = snapshotFlipRects(container)
        }
      })
    })

    // Delay-gated skeleton reveal. Watching status() (not a specific call site) gates regardless of
    // who re-entered LOADING — the shared store can reload from anywhere (retry, friend-approve, …).
    // On entering LOADING we arm the timer; on leaving it we cancel and hide. The timer's status()
    // read is outside the reactive context (async), so it doesn't track and can't loop the effect.
    effect(() => {
      const loading = this.status() === ConversationLoadStatus.LOADING
      clearTimeout(this.skeletonTimer)
      if (loading) {
        this.skeletonTimer = setTimeout(() => {
          if (this.status() === ConversationLoadStatus.LOADING) this.skeletonVisible.set(true)
        }, ThreadListComponent.SKELETON_DELAY)
      } else {
        this.skeletonVisible.set(false)
      }
    })
  }

  readonly items = this.convList.items
  readonly status = this.convList.status
  readonly errorMsg = this.convList.error
  readonly openThreadId = this.convList.openThreadId
  /** exposes the enum to the template's @switch */
  readonly LoadStatus: typeof ConversationLoadStatus = ConversationLoadStatus

  /** Per-row width config (percent of the info column) for the loading skeleton. Gentle variation
   *  across the name and message bars avoids a rigid barcode rhythm; values are purely cosmetic. */
  readonly skeletonRows = [
    { name: 42, msg: 68 },
    { name: 55, msg: 55 },
    { name: 38, msg: 72 },
    { name: 60, msg: 45 },
    { name: 48, msg: 62 },
    { name: 52, msg: 58 },
    { name: 45, msg: 50 },
    { name: 58, msg: 66 },
    { name: 44, msg: 60 },
    { name: 50, msg: 56 },
  ] as const

  /** view model after applying the folder + search filters. */
  readonly filteredThreadList = computed(() => {
    const folder = this.folder(), q = this.searchText().trim().toLowerCase()
    return this.items().filter(t => {
      if (folder && !inFolder(t, folder)) return false
      if (q) {
        const name = displayThreadName(t)
        if (!name.toLowerCase().includes(q)) return false
      }
      return true
    })
  })

  /** A search term is set but the filter yields nothing → "no search results" state (distinct from the true
   *  empty state; carries no CTA). */
  readonly isSearchEmpty = computed(() =>
    this.searchText().trim().length > 0 && this.filteredThreadList().length === 0
  )

  @Output() onSelect = new EventEmitter<ConversationItem>()

  /** Display name for a thread — alias overrides the real name. */
  displayName(t: ConversationItem): string {
    return displayThreadName(t)
  }

  /** Backend denormalizes `lastMessagePreview` as an English marker for non-text messages ("[Photo]",
   *  "[Group invite]", … — see backend derivePreview). Recognize that closed set here and translate it;
   *  real text previews pass through untouched. Reads the language signal so the row re-evaluates on a
   *  language switch. The "You:" prefix is shown for the sender's own messages (the missed-summary carries
   *  `creator`, not the sender's display name, so incoming messages show bare — no "Alice:" prefix). */
  private static readonly PREVIEW_MARKERS: Readonly<Record<string, string>> = {
    '[Photo]': 'chat.preview.photo',
    '[Group invite]': 'chat.preview.invite',
    '[Video]': 'chat.preview.video',
    '[File]': 'chat.preview.file',
    '[Voice message]': 'chat.preview.voice',
  };

  previewText(t: ConversationItem): string {
    this.language.lang();
    const raw = t.lastMessagePreview;
    const markerKey = raw ? ThreadListComponent.PREVIEW_MARKERS[raw] : undefined;
    const base = (markerKey ? this.transloco.translate(markerKey) : raw)
      ?? this.transloco.translate('common.noMessagesYet') ?? '';
    if (t.lastMessageSenderId == null) return base;
    if (t.lastMessageSenderId === this.userService.sessionProfile()?.id)
      return this.transloco.translate('chat.youPrefix', { text: base }) ?? '';
    return base;
  }

  /** Conversation-list timestamp; reads the language signal so it re-evaluates on a language switch. */
  fmtTime = (ms: number | null | undefined): string => {
    this.language.lang()
    return formatListTime(ms, this.transloco)
  }

  genThreadList() {
    this.convList.load()
  }

  /** True-empty-state CTA: open the friend-requests popup (same path as the icon rail). */
  openFriendRequests() {
    this.routeService.popupDlg(PopupType.FRIEND_REQUESTS)
  }

  onUsrTrdClick(userMsgTrd: ConversationItem) {
    this.onSelect.emit(userMsgTrd)
  }

  ngOnInit() {
    // Load only if we don't already have data (the store is shared across layout switches).
    if (this.status() === ConversationLoadStatus.LOADING && this.items().length === 0) this.convList.load()
  }

  ngOnDestroy() {
    clearTimeout(this.skeletonTimer)
  }
}
