import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDividerModule } from '@angular/material/divider';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import {
  IconComponent,
  AppIconType,
} from '../../app/components/icon/icon.component';
import { LanguageService } from '../../app/services/language.service';
import { ThemeService } from '../../app/services/theme.service';
import { TranslocoService } from '@jsverse/transloco';
import {
  deploymentMessages,
  ensureDeploymentTranslations,
} from '../deployment/deployment-i18n';

import { PageNotFoundComponent } from '../../app/pages/page-not-found/page-not-found.component';
import { ForbiddenPageComponent } from '../../app/pages/forbidden-page/forbidden-page.component';

export type MentionTarget = 'me' | 'all' | 'other';
export type CardGenStatus = 'idle' | 'pending' | 'succeeded' | 'failed';

interface DemoThreadItem {
  id: number;
  name: string;
  avatarText: string;
  time: string;
  snippet: string;
  unreadCount: number;
  hasMention: boolean;
  isMuted: boolean;
  isPinned: boolean;
}

@Component({
  selector: 'app-effects-page',
  imports: [
    CommonModule,
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatButtonToggleModule,
    MatDividerModule,
    MatCheckboxModule,
    MatSlideToggleModule,
    MatTooltipModule,
    IconComponent,
    PageNotFoundComponent,
    ForbiddenPageComponent,
  ],
  template: `
    <div class="tool" [class.rail-open]="!collapsed()">
      <!-- Navigation Sidebar (Unified with Deployment & Playground) -->
      <nav
        class="sidebar"
        [class.collapsed]="collapsed()"
        [attr.aria-label]="t().nav.effects"
      >
        <button
          class="rail-item toggle-btn"
          type="button"
          (click)="collapsed.set(!collapsed())"
          [attr.aria-label]="collapsed() ? t().nav.expand : t().nav.collapse"
        >
          <app-icon
            class="icon"
            [type]="AppIconType.MENU"
            [style]="navIconStyle"
            aria-hidden="true"
          />
          @if (!collapsed()) {
            <strong>SOMS</strong>
          }
        </button>
        <a
          class="rail-item"
          routerLink="/"
          [title]="t().nav.chat"
          [attr.aria-label]="t().nav.chat"
        >
          <app-icon
            class="icon"
            [type]="AppIconType.CHATS"
            [style]="navIconStyle"
            aria-hidden="true"
          />
          @if (!collapsed()) {
            <span>{{ t().nav.chat }}</span>
          }
        </a>
        <a
          class="rail-item"
          routerLink="/deploy"
          [title]="t().nav.deploy"
          [attr.aria-label]="t().nav.deploy"
        >
          <app-icon
            class="icon"
            [type]="AppIconType.SETTINGS"
            [style]="navIconStyle"
            aria-hidden="true"
          />
          @if (!collapsed()) {
            <span>{{ t().nav.deploy }}</span>
          }
        </a>
        <a
          class="rail-item selected"
          routerLink="/effects"
          aria-current="page"
          [title]="t().nav.effects"
          [attr.aria-label]="t().nav.effects"
        >
          <app-icon
            class="icon"
            [type]="AppIconType.NOTIFICATIONS"
            [style]="navIconStyle"
            aria-hidden="true"
          />
          @if (!collapsed()) {
            <span>{{ t().nav.effects }}</span>
          }
        </a>

        <div class="sidebar-footer">
          <button
            class="rail-item"
            type="button"
            (click)="toggleTheme()"
            [title]="themeTitle()"
            [attr.aria-label]="themeTitle()"
          >
            <app-icon
              class="icon"
              [type]="themeIcon()"
              [style]="navIconStyle"
              aria-hidden="true"
            />
            @if (!collapsed()) {
              <span>{{ themeLabel() }}</span>
            }
          </button>
          <button
            class="rail-item"
            type="button"
            (click)="toggleLanguage()"
            [title]="t().nav.language"
            [attr.aria-label]="t().nav.language"
          >
            <app-icon
              class="icon"
              [type]="AppIconType.GLOBE"
              [style]="navIconStyle"
              aria-hidden="true"
            />
            @if (!collapsed()) {
              <span>{{ language.langLabel() }}</span>
            }
          </button>
        </div>
      </nav>

      @if (!collapsed()) {
        <button
          class="backdrop"
          type="button"
          (click)="collapsed.set(true)"
          [attr.aria-label]="t().nav.collapse"
        ></button>
      }

      <!-- Main Scrollable Content Area -->
      <main class="main-content" (click)="closeContextMenu()">
        <div class="workspace">
          <!-- Page Header -->
          <header class="demo-header">
            <div class="header-top">
              <div class="title-group">
                <h1>Visual Effects & Interactions Showcase</h1>
                <p>
                  Official catalog of SOMS dynamic motion, entry pulses, jump highlights, composer media card generation, search cues, and thread list interactions.
                </p>
              </div>
              <div class="header-actions">
                <button
                  mat-flat-button
                  color="primary"
                  type="button"
                  (click)="triggerAll()"
                >
                  ▶ Replay All Effects
                </button>
              </div>
            </div>

            <!-- In-Page Sub Navigation -->
            <nav class="effects-nav-tabs" aria-label="Showcase Sections">
              <a class="nav-tab" href="#section-mention" (click)="scrollTo('section-mention', $event)">
                &#64; Mention Pulse
              </a>
              <a class="nav-tab" href="#section-media" (click)="scrollTo('section-media', $event)">
                Media Cards
              </a>
              <a class="nav-tab" href="#section-jump" (click)="scrollTo('section-jump', $event)">
                Jump Target
              </a>
              <a class="nav-tab" href="#section-search" (click)="scrollTo('section-search', $event)">
                Search Cue
              </a>
              <a class="nav-tab" href="#section-threads" (click)="scrollTo('section-threads', $event)">
                Thread List
              </a>
              <a class="nav-tab nav-tab--highlight" href="#section-errors" (click)="scrollTo('section-errors', $event)">
                <span class="nav-tab-badge">New</span>
                404 & 403 Error Pages
              </a>
            </nav>
          </header>

          <!-- ======================================================== -->
          <!-- SECTION 1: @ Mention Breathing Glow (Official Option A) -->
          <!-- ======================================================== -->
          <mat-card appearance="outlined" class="showcase-card" id="section-mention">
            <mat-card-header class="showcase-card-header">
              <div class="header-text-block">
                <span class="section-tag">Production Motion</span>
                <mat-card-title>@ Mention Entrance Pulse (Soft Breathing Glow)</mat-card-title>
                <mat-card-subtitle>
                  Subtle 22% ease-in illumination · 1px soft tint ring · layered Gaussian blur glow · color-mix theme adaptation
                </mat-card-subtitle>
              </div>
              <button
                mat-stroked-button
                type="button"
                (click)="triggerMentionPulse()"
              >
                Replay Pulse
              </button>
            </mat-card-header>

            <mat-card-content class="showcase-card-body">
              <div class="mention-target-row">
                <mat-button-toggle-group
                  [value]="mentionTarget()"
                  (change)="setMentionTarget($event.value)"
                  aria-label="Select mention target"
                >
                  <mat-button-toggle value="me">&#64;You (Mention Viewer)</mat-button-toggle>
                  <mat-button-toggle value="all">&#64;Everyone (Mention All)</mat-button-toggle>
                  <mat-button-toggle value="other">&#64;Other (Mention Another User)</mat-button-toggle>
                </mat-button-toggle-group>
              </div>

              <div class="chat-wallpaper-stage">
                <div class="chat-row">
                  <div class="avatar">AL</div>
                  <div class="message-col">
                    <span class="sender-name">Alice</span>
                    <div
                      class="chat-bubble"
                      [class.bubble-mention-me-pulse]="
                        activeMentionPulse() && mentionTarget() === 'me'
                      "
                      [class.bubble-mention-all-pulse]="
                        activeMentionPulse() && mentionTarget() === 'all'
                      "
                      [class.bubble-mention-other-pulse]="
                        activeMentionPulse() && mentionTarget() === 'other'
                      "
                    >
                      @if (mentionTarget() === 'me') {
                        Hi <span class="msg-mention msg-mention--me">&#64;You</span>, could you check the deploy logs when you get a chance?
                      } @else if (mentionTarget() === 'all') {
                        Notice <span class="msg-mention msg-mention--all">&#64;Everyone</span>, system maintenance starts tonight at 22:00.
                      } @else {
                        Could <span class="msg-mention msg-mention--other">&#64;Bob</span> please share an update with the team?
                      }
                      <span class="chat-meta">14:20</span>
                    </div>
                  </div>
                </div>
              </div>

              <mat-divider></mat-divider>

              <div class="specs-grid">
                <div class="spec-col">
                  <span class="spec-label">Timing Function</span>
                  <span class="spec-val">1300ms cubic-bezier(0.2, 0.8, 0.25, 1)</span>
                </div>
                <div class="spec-col">
                  <span class="spec-label">Illumination Curve</span>
                  <span class="spec-val">0% baseline → 22% warm glow peak → 100% natural decay</span>
                </div>
                <div class="spec-col">
                  <span class="spec-label">Dark Theme Safe</span>
                  <span class="spec-val">color-mix(in srgb, var(--bubble-bg) 84%, #f97316 16%)</span>
                </div>
              </div>
            </mat-card-content>
          </mat-card>

          <!-- ======================================================== -->
          <!-- SECTION 2: Media / Link Card Generation in Composer      -->
          <!-- ======================================================== -->
          <mat-card appearance="outlined" class="showcase-card" id="section-media">
            <mat-card-header class="showcase-card-header">
              <div class="header-text-block">
                <span class="section-tag">Composer Dynamics</span>
                <mat-card-title>Media & Link Card Generation Effects (Composer)</mat-card-title>
                <mat-card-subtitle>
                  URL pop-up action button with breathing core pulse (ci-link-core-breathe) and skeleton radial glow (link-card-content-glow).
                </mat-card-subtitle>
              </div>
              <button
                mat-stroked-button
                type="button"
                (click)="simulateCardGeneration()"
              >
                Simulate Generation Flow
              </button>
            </mat-card-header>

            <mat-card-content class="showcase-card-body">
              <div class="composer-demo-wrapper">
                <!-- Composer Input Capsule Simulation -->
                <div class="composer-sim-bar">
                  <div class="composer-capsule">
                    <!-- Floating Link Action Button -->
                    <button
                      type="button"
                      class="ci-link-action"
                      [class.ci-link-action--visible]="cardGenStatus() !== 'idle'"
                      [class.ci-link-action--pending]="cardGenStatus() === 'pending'"
                      [class.ci-link-action--ready]="cardGenStatus() === 'succeeded'"
                      [class.ci-link-action--failed]="cardGenStatus() === 'failed'"
                      (click)="toggleCardGenState()"
                      [title]="'Link card action state: ' + cardGenStatus()"
                    >
                      <span class="ci-link-action-core" aria-hidden="true">
                        @if (cardGenStatus() === 'succeeded') {
                          <span class="favicon-dot">🌐</span>
                        } @else {
                          <svg
                            width="18"
                            height="18"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                          >
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                          </svg>
                        }
                      </span>
                    </button>

                    <div class="composer-text-field">
                      <span class="composer-plain">Check out this architecture update: </span>
                      <span class="composer-link-text">https://github.com/hapood/soms</span>
                    </div>

                    <div class="composer-status-chip">
                      Status: <strong>{{ cardGenStatus() | uppercase }}</strong>
                    </div>
                  </div>
                </div>

                <!-- Generated Media / Link Card Preview Component -->
                <div class="card-preview-area">
                  @if (cardGenStatus() === 'pending') {
                    <!-- Skeleton with Radial Breathing Glow -->
                    <div class="link-card-content link-card-content--loading">
                      <div class="link-card-content__image">
                        <span class="link-card-content__skeleton-block"></span>
                      </div>
                      <div class="link-card-content__text">
                        <span class="link-card-content__skeleton-line"></span>
                        <span class="link-card-content__skeleton-line"></span>
                        <span class="link-card-content__skeleton-line"></span>
                      </div>
                    </div>
                  } @else if (cardGenStatus() === 'succeeded' || cardGenStatus() === 'idle') {
                    <!-- Succeeded High-Fidelity Rich Media Card -->
                    <div class="link-card-content">
                      <div class="link-card-content__image">
                        <div class="card-img-placeholder">
                          <app-icon
                            [type]="AppIconType.IMAGE"
                            [style]="{ width: '28px', height: '28px' }"
                          />
                        </div>
                      </div>
                      <div class="link-card-content__text">
                        <div class="link-card-content__title">
                          SOMS: Simple Open Messaging Service v1.4
                        </div>
                        <div class="link-card-content__description">
                          Federated real-time open communication server architecture with Drizzle ORM and Rust client core.
                        </div>
                        <div class="link-card-content__source">
                          <span class="source-favicon">🌐</span> github.com/hapood/soms
                        </div>
                      </div>
                    </div>
                  } @else {
                    <!-- Failed State -->
                    <div class="link-card-content link-card-content--failed">
                      <div class="failure-icon">!</div>
                      <div class="failure-text">
                        <strong>Card generation failed</strong>
                        <p>This web page could not be reached or preview metadata is unavailable.</p>
                      </div>
                    </div>
                  }
                </div>
              </div>

              <mat-divider></mat-divider>

              <div class="specs-grid">
                <div class="spec-col">
                  <span class="spec-label">Composer Capsule Motion</span>
                  <span class="spec-val">Spring-in: translateY(12px) scale(0.84) → translateY(0) scale(1)</span>
                </div>
                <div class="spec-col">
                  <span class="spec-label">Pending Icon Pulse</span>
                  <span class="spec-val">ci-link-core-breathe 1.45s ease-in-out infinite (scale 0.82 → 1.12)</span>
                </div>
                <div class="spec-col">
                  <span class="spec-label">Skeleton Radial Glow</span>
                  <span class="spec-val">link-card-content-glow 2.4s ease-in-out infinite with brand tint</span>
                </div>
              </div>
            </mat-card-content>
          </mat-card>

          <!-- ======================================================== -->
          <!-- SECTION 3: Jump & Navigation Flash (.cb-jump-highlight)  -->
          <!-- ======================================================== -->
          <mat-card appearance="outlined" class="showcase-card" id="section-jump">
            <mat-card-header class="showcase-card-header">
              <div class="header-text-block">
                <span class="section-tag">Navigation Cue</span>
                <mat-card-title>Jump & Re-anchor Target Flash (.cb-jump-highlight)</mat-card-title>
                <mat-card-subtitle>
                  One-shot paint-only overlay flash (0.9s ease-out) triggered when navigating from quote replies, unread jumps, or search hits.
                </mat-card-subtitle>
              </div>
              <button
                mat-stroked-button
                type="button"
                (click)="triggerJumpFlash()"
              >
                Trigger Jump Flash
              </button>
            </mat-card-header>

            <mat-card-content class="showcase-card-body">
              <div class="chat-wallpaper-stage">
                <div class="chat-row">
                  <div class="avatar avatar--blue">DK</div>
                  <div class="message-col">
                    <span class="sender-name">David</span>
                    <div
                      class="chat-bubble"
                      [class.cb-jump-highlight]="activeJumpFlash()"
                    >
                      Here is the quoted reference message that the scroller jumped back to locate.
                      <span class="chat-meta">13:45</span>
                    </div>
                  </div>
                </div>
              </div>

              <mat-divider></mat-divider>

              <div class="specs-grid">
                <div class="spec-col">
                  <span class="spec-label">CSS Mechanism</span>
                  <span class="spec-val">::after pseudo-element (zero height reflow, 0 reflow jitter)</span>
                </div>
                <div class="spec-col">
                  <span class="spec-label">Flash Timing</span>
                  <span class="spec-val">0.9s ease-out (0%–35% brand accent tint → fade to transparent)</span>
                </div>
                <div class="spec-col">
                  <span class="spec-label">Triggered By</span>
                  <span class="spec-val">Quote jump click, unread bar jump, in-chat search navigation</span>
                </div>
              </div>
            </mat-card-content>
          </mat-card>

          <!-- ======================================================== -->
          <!-- SECTION 4: In-Chat Search & Keyword Matching             -->
          <!-- ======================================================== -->
          <mat-card appearance="outlined" class="showcase-card" id="section-search">
            <mat-card-header class="showcase-card-header">
              <div class="header-text-block">
                <span class="section-tag">Search Experience</span>
                <mat-card-title>In-Chat Search & Keyword Highlighting</mat-card-title>
                <mat-card-subtitle>
                  Real-time keyword mark matches with jump-navigation integration and match cycling.
                </mat-card-subtitle>
              </div>
            </mat-card-header>

            <mat-card-content class="showcase-card-body">
              <div class="search-bar-sim">
                <div class="search-input-wrap">
                  <app-icon
                    class="search-icon"
                    [type]="AppIconType.SEARCH"
                    [style]="{ width: '18px', height: '18px' }"
                  />
                  <input
                    type="text"
                    class="search-input"
                    placeholder="Search keywords in messages..."
                    [(ngModel)]="searchQuery"
                    (ngModelChange)="onSearchChange()"
                  />
                  <span class="search-match-count">
                    {{ currentMatchIndex() + 1 }} / {{ totalMatches() }} matches
                  </span>
                </div>
                <div class="search-nav-buttons">
                  <button
                    mat-icon-button
                    type="button"
                    (click)="cycleSearchMatch(-1)"
                    title="Previous match"
                  >
                    ▲
                  </button>
                  <button
                    mat-icon-button
                    type="button"
                    (click)="cycleSearchMatch(1)"
                    title="Next match"
                  >
                    ▼
                  </button>
                </div>
              </div>

              <div class="chat-wallpaper-stage">
                <div class="chat-row">
                  <div class="avatar avatar--purple">EL</div>
                  <div class="message-col">
                    <span class="sender-name">Elena</span>
                    <div
                      class="chat-bubble"
                      [class.cb-jump-highlight]="activeSearchJump()"
                    >
                      <span [innerHTML]="highlightedSearchText()"></span>
                      <span class="chat-meta">14:15</span>
                    </div>
                  </div>
                </div>
              </div>

              <mat-divider></mat-divider>

              <div class="specs-grid">
                <div class="spec-col">
                  <span class="spec-label">Highlight Method</span>
                  <span class="spec-val">&lt;mark class="search-match"&gt; with brand highlight wash</span>
                </div>
                <div class="spec-col">
                  <span class="spec-label">Active Match Feedback</span>
                  <span class="spec-val">Smooth jump scroll + one-shot .cb-jump-highlight target flash</span>
                </div>
              </div>
            </mat-card-content>
          </mat-card>

          <!-- ======================================================== -->
          <!-- SECTION 5: Thread List Item Interactions                 -->
          <!-- ======================================================== -->
          <mat-card appearance="outlined" class="showcase-card" id="section-threads">
            <mat-card-header class="showcase-card-header">
              <div class="header-text-block">
                <span class="section-tag">Conversation List Dynamics</span>
                <mat-card-title>Thread List Item Motion & Interaction States</mat-card-title>
                <mat-card-subtitle>
                  Hover feedback, active selection, @mention urgency badge, new message counters, multi-select shrink motion, and context menu.
                </mat-card-subtitle>
              </div>
              <div class="header-controls-cluster">
                <mat-slide-toggle
                  [checked]="multiSelectMode()"
                  (change)="toggleMultiSelect($event.checked)"
                >
                  Multi-Select Shrink Mode
                </mat-slide-toggle>
              </div>
            </mat-card-header>

            <mat-card-content class="showcase-card-body">
              <div class="thread-demo-layout">
                <!-- Thread List Container (matches 72px item contract) -->
                <div class="thread-list-container">
                  @for (thread of demoThreads(); track thread.id) {
                    <div
                      class="thread-item-row"
                      [class.active]="selectedThreadId() === thread.id"
                      [class.multi-select-active]="multiSelectMode()"
                      (click)="onThreadClick(thread.id)"
                      (contextmenu)="onThreadRightClick($event, thread)"
                    >
                      <!-- Multi-select checkbox column (slides in, triggers shrink) -->
                      <div class="thread-checkbox-col">
                        <mat-checkbox
                          [checked]="selectedThreadIds().has(thread.id)"
                          (change)="toggleThreadSelect(thread.id)"
                          (click)="$event.stopPropagation()"
                        ></mat-checkbox>
                      </div>

                      @if (thread.isPinned) {
                        <span class="pin-corner-badge" title="Pinned conversation">
                          <app-icon
                            [type]="AppIconType.PIN"
                            [style]="{ width: '12px', height: '12px' }"
                          />
                        </span>
                      }

                      <div class="thread-avatar-slot">
                        <div class="thread-avatar-circle" [class.avatar-group]="thread.id === 2">
                          {{ thread.avatarText }}
                        </div>
                      </div>

                      <div class="thread-info-slot">
                        <div class="thread-top-line">
                          <span class="thread-title" [class.bold]="thread.unreadCount > 0">
                            {{ thread.name }}
                          </span>

                          @if (thread.hasMention) {
                            <span class="thread-mention-badge" title="Mentioned you">&#64;</span>
                          }

                          <span class="thread-timestamp" [class.brand-tint]="thread.unreadCount > 0">
                            {{ thread.time }}
                          </span>
                        </div>

                        <div class="thread-bottom-line">
                          <span class="thread-snippet-text">
                            @if (thread.isMuted) {
                              <app-icon
                                class="inline-mute-icon"
                                [type]="AppIconType.MUTE"
                                [style]="{ width: '13px', height: '13px' }"
                              />
                            }
                            @if (thread.hasMention) {
                              <span class="mention-prefix-text">&#64;Mentioned you: </span>
                            }
                            {{ thread.snippet }}
                          </span>

                          @if (thread.unreadCount > 0) {
                            <span class="thread-unread-pill" [class.muted-pill]="thread.isMuted">
                              {{ thread.unreadCount > 99 ? '99+' : thread.unreadCount }}
                            </span>
                          }
                        </div>
                      </div>

                      <button
                        mat-icon-button
                        type="button"
                        class="thread-action-more"
                        title="Conversation actions"
                        (click)="onThreadRightClick($event, thread); $event.stopPropagation()"
                      >
                        <app-icon
                          [type]="AppIconType.MORE"
                          [style]="{ width: '16px', height: '16px' }"
                        />
                      </button>
                    </div>
                  }
                </div>

                <!-- Interaction Guide / Notes -->
                <div class="interaction-guide-panel">
                  <h4>Try These Real Interactions:</h4>
                  <ul class="guide-list">
                    <li>
                      <strong>Hover:</strong> Move your mouse over any row to see smooth background highlight transition.
                    </li>
                    <li>
                      <strong>Click to Select:</strong> Click any thread to activate selection state (<code>.active</code>) with selection highlight.
                    </li>
                    <li>
                      <strong>Multi-Select Shrink:</strong> Toggle the switch above. Notice how the checkbox column smoothly slides in and the row content cleanly shrinks without layout jitter.
                    </li>
                    <li>
                      <strong>Right-Click Menu:</strong> Right-click on any row (or click <code>⋮</code>) to open the floating context menu.
                    </li>
                    <li>
                      <strong>Urgent Mention Badge:</strong> Notice Thread #2 with the dedicated red <code>&#64;</code> badge and prefix.
                    </li>
                  </ul>
                </div>
              </div>

              <!-- Context Menu Popup overlay -->
              @if (contextMenuOpen()) {
                <div
                  class="context-menu-popup"
                  [style.left.px]="contextMenuPos().x"
                  [style.top.px]="contextMenuPos().y"
                  (click)="$event.stopPropagation()"
                >
                  <button type="button" class="menu-item" (click)="closeContextMenu()">
                    <app-icon [type]="AppIconType.PIN" [style]="{ width: '16px', height: '16px' }" />
                    <span>{{ activeContextThread()?.isPinned ? 'Unpin' : 'Pin to Top' }}</span>
                  </button>
                  <button type="button" class="menu-item" (click)="closeContextMenu()">
                    <app-icon [type]="AppIconType.CHECK" [style]="{ width: '16px', height: '16px' }" />
                    <span>Mark as Read</span>
                  </button>
                  <button type="button" class="menu-item" (click)="closeContextMenu()">
                    <app-icon [type]="AppIconType.MUTE" [style]="{ width: '16px', height: '16px' }" />
                    <span>{{ activeContextThread()?.isMuted ? 'Unmute' : 'Mute Notifications' }}</span>
                  </button>
                  <mat-divider></mat-divider>
                  <button type="button" class="menu-item menu-item--danger" (click)="closeContextMenu()">
                    <app-icon [type]="AppIconType.TRASH" [style]="{ width: '16px', height: '16px' }" />
                    <span>Delete Conversation</span>
                  </button>
                </div>
              }
            </mat-card-content>
          </mat-card>

          <!-- ======================================================== -->
          <!-- SECTION 6: Error & Permission Pages (404 & 403)         -->
          <!-- ======================================================== -->
          <mat-card appearance="outlined" class="showcase-card" id="section-errors">
            <mat-card-header class="showcase-card-header">
              <div class="header-text-block">
                <span class="section-tag">System States & Diagnostics</span>
                <mat-card-title>404 Page Not Found & 403 Forbidden Redesign</mat-card-title>
                <mat-card-subtitle>
                  Material Design 3 layout · SOMS graphite & action-blue palette · integer-pixel metrics · responsive viewports
                </mat-card-subtitle>
              </div>
              <div class="header-actions">
                <a mat-stroked-button routerLink="/404" target="_blank">
                  Standalone 404 ↗
                </a>
                <a mat-stroked-button routerLink="/403" target="_blank">
                  Standalone 403 ↗
                </a>
              </div>
            </mat-card-header>

            <mat-card-content class="showcase-card-body">
              <!-- Internal Navigation Controls for Error Pages -->
              <div class="error-pages-nav-bar">
                <div class="nav-bar-group">
                  <span class="nav-bar-label">Preview Page:</span>
                  <mat-button-toggle-group
                    [value]="activeErrorPage()"
                    (change)="activeErrorPage.set($event.value)"
                    aria-label="Select Error Page Preview"
                  >
                    <mat-button-toggle value="404">
                      🔍 404 (Page Not Found · 页面未找到)
                    </mat-button-toggle>
                    <mat-button-toggle value="403">
                      🔒 403 (Access Denied · 未授权)
                    </mat-button-toggle>
                  </mat-button-toggle-group>
                </div>

                <div class="nav-bar-group">
                  <span class="nav-bar-label">Viewport:</span>
                  <mat-button-toggle-group
                    [value]="errorViewport()"
                    (change)="errorViewport.set($event.value)"
                    aria-label="Viewport Mode"
                  >
                    <mat-button-toggle value="fluid">100% Fluid</mat-button-toggle>
                    <mat-button-toggle value="desktop">1024px</mat-button-toggle>
                    <mat-button-toggle value="tablet">768px</mat-button-toggle>
                    <mat-button-toggle value="mobile">390px</mat-button-toggle>
                  </mat-button-toggle-group>
                </div>
              </div>

              <!-- Preview Stage with device framing -->
              <div class="error-preview-stage" [attr.data-viewport]="errorViewport()">
                <div class="error-device-shell" [class.framed]="errorViewport() !== 'fluid'">
                  @if (errorViewport() !== 'fluid') {
                    <div class="mock-browser-bar">
                      <span class="browser-dot"></span>
                      <span class="browser-dot"></span>
                      <span class="browser-dot"></span>
                      <span class="browser-address">soms://mesh/{{ activeErrorPage() === '404' ? 'lost-signal' : 'restricted-channel' }}</span>
                      <span class="browser-meta">{{ errorViewportWidth() }}</span>
                    </div>
                  }
                  <div class="error-component-mount">
                    @if (activeErrorPage() === '404') {
                      <app-page-not-found />
                    } @else {
                      <app-forbidden />
                    }
                  </div>
                </div>
              </div>
            </mat-card-content>
          </mat-card>
        </div>
      </main>
    </div>
  `,
  styleUrl: './effects-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EffectsPageComponent {
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  private readonly translator = inject(TranslocoService);

  readonly t = computed(() => {
    const lang = this.language.lang();
    const key = lang.startsWith('zh') ? 'zh' : 'en';
    const translation = this.translator.translateObject<
      typeof deploymentMessages.en
    >('deployment', {}, lang);
    return translation ?? deploymentMessages[key];
  });

  constructor() {
    ensureDeploymentTranslations(this.translator);
  }

  readonly collapsed = signal(
    typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 600px)').matches,
  );

  readonly navIconStyle = { width: '20px', height: '20px' };
  readonly AppIconType = AppIconType;

  // 6. Error & Permission Pages State
  readonly activeErrorPage = signal<'404' | '403'>('404');
  readonly errorViewport = signal<'fluid' | 'desktop' | 'tablet' | 'mobile'>(
    'fluid',
  );

  readonly errorViewportWidth = computed(() => {
    switch (this.errorViewport()) {
      case 'desktop':
        return '1024px';
      case 'tablet':
        return '768px';
      case 'mobile':
        return '390px';
      default:
        return '100%';
    }
  });

  scrollTo(sectionId: string, event: Event): void {
    event.preventDefault();
    const el = document.getElementById(sectionId);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 1. Mention Pulse State (Option A)
  readonly mentionTarget = signal<MentionTarget>('me');
  readonly activeMentionPulse = signal(true);

  // 2. Composer Card Generation State
  readonly cardGenStatus = signal<CardGenStatus>('pending');

  // 3. Jump Flash State
  readonly activeJumpFlash = signal(false);

  // 4. Search Matching State
  searchQuery = 'deploy';
  readonly currentMatchIndex = signal(0);
  readonly totalMatches = signal(3);
  readonly activeSearchJump = signal(false);
  private readonly searchBaseText =
    'Please verify the deploy script and Docker compose configuration before we proceed with the cluster deploy update.';

  // 5. Thread List Dynamics State
  readonly multiSelectMode = signal(false);
  readonly selectedThreadId = signal<number>(1);
  readonly selectedThreadIds = signal<Set<number>>(new Set([1]));

  readonly contextMenuOpen = signal(false);
  readonly contextMenuPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  readonly activeContextThread = signal<DemoThreadItem | null>(null);

  readonly demoThreads = signal<DemoThreadItem[]>([
    {
      id: 1,
      name: 'Alice Cooper',
      avatarText: 'AC',
      time: '14:28',
      snippet: 'Sounds great! I will review the pull request this afternoon.',
      unreadCount: 0,
      hasMention: false,
      isMuted: false,
      isPinned: true,
    },
    {
      id: 2,
      name: 'Core Engineering Group',
      avatarText: 'ENG',
      time: '14:20',
      snippet: 'Can you check the benchmark results when you get a chance?',
      unreadCount: 3,
      hasMention: true,
      isMuted: false,
      isPinned: false,
    },
    {
      id: 3,
      name: 'Bob Vance',
      avatarText: 'BV',
      time: '12:05',
      snippet: 'Meeting rescheduled to Thursday 10:00 AM.',
      unreadCount: 5,
      hasMention: false,
      isMuted: false,
      isPinned: false,
    },
    {
      id: 4,
      name: 'Release Announcements',
      avatarText: 'REL',
      time: 'Yesterday',
      snippet: 'v1.4.0 rollout has been successfully completed.',
      unreadCount: 120,
      hasMention: false,
      isMuted: true,
      isPinned: false,
    },
    {
      id: 5,
      name: 'David Kim',
      avatarText: 'DK',
      time: 'Oct 24',
      snippet: 'Sent you the Figma design tokens link.',
      unreadCount: 0,
      hasMention: false,
      isMuted: false,
      isPinned: false,
    },
  ]);

  setMentionTarget(target: MentionTarget): void {
    this.mentionTarget.set(target);
    this.triggerMentionPulse();
  }

  triggerMentionPulse(): void {
    this.activeMentionPulse.set(false);
    requestAnimationFrame(() => this.activeMentionPulse.set(true));
  }

  simulateCardGeneration(): void {
    this.cardGenStatus.set('pending');
    setTimeout(() => {
      this.cardGenStatus.set('succeeded');
    }, 1800);
  }

  toggleCardGenState(): void {
    const states: CardGenStatus[] = ['pending', 'succeeded', 'failed', 'idle'];
    const next =
      states[(states.indexOf(this.cardGenStatus()) + 1) % states.length];
    this.cardGenStatus.set(next);
  }

  triggerJumpFlash(): void {
    this.activeJumpFlash.set(false);
    requestAnimationFrame(() => this.activeJumpFlash.set(true));
    setTimeout(() => this.activeJumpFlash.set(false), 950);
  }

  triggerAll(): void {
    this.triggerMentionPulse();
    this.triggerJumpFlash();
    this.flashSearchMatch();
    this.simulateCardGeneration();
  }

  // Search Match Highlighting
  onSearchChange(): void {
    const q = this.searchQuery.trim();
    if (!q) {
      this.totalMatches.set(0);
      return;
    }
    const matches =
      this.searchBaseText.toLowerCase().split(q.toLowerCase()).length - 1;
    this.totalMatches.set(Math.max(1, matches));
    this.currentMatchIndex.set(0);
  }

  cycleSearchMatch(delta: number): void {
    const total = this.totalMatches();
    if (total <= 1) return;
    const next = (this.currentMatchIndex() + delta + total) % total;
    this.currentMatchIndex.set(next);
    this.flashSearchMatch();
  }

  private flashSearchMatch(): void {
    this.activeSearchJump.set(false);
    requestAnimationFrame(() => this.activeSearchJump.set(true));
    setTimeout(() => this.activeSearchJump.set(false), 950);
  }

  highlightedSearchText(): string {
    const q = this.searchQuery.trim();
    if (!q) return this.searchBaseText;
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    return this.searchBaseText.replace(
      regex,
      '<mark class="search-highlight">$1</mark>',
    );
  }

  // Thread interactions
  onThreadClick(id: number): void {
    if (this.multiSelectMode()) {
      this.toggleThreadSelect(id);
    } else {
      this.selectedThreadId.set(id);
    }
  }

  toggleMultiSelect(enabled: boolean): void {
    this.multiSelectMode.set(enabled);
    if (!enabled) {
      this.selectedThreadIds.set(new Set([this.selectedThreadId()]));
    }
  }

  toggleThreadSelect(id: number): void {
    this.selectedThreadIds.update((set) => {
      const next = new Set(set);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  onThreadRightClick(event: MouseEvent, thread: DemoThreadItem): void {
    event.preventDefault();
    this.activeContextThread.set(thread);
    const x = Math.min(event.clientX, window.innerWidth - 220);
    const y = Math.min(event.clientY, window.innerHeight - 200);
    this.contextMenuPos.set({ x, y });
    this.contextMenuOpen.set(true);
  }

  closeContextMenu(): void {
    this.contextMenuOpen.set(false);
  }

  themeIcon(): AppIconType {
    const mode = this.theme.mode();
    if (mode === 'system') return AppIconType.CONTRAST;
    return mode === 'dark' ? AppIconType.MOON : AppIconType.SUN;
  }

  themeLabel() {
    const mode = this.theme.mode();
    if (mode === 'system') return this.t().themeSystem;
    return mode === 'dark' ? this.t().themeDark : this.t().themeLight;
  }

  themeTitle() {
    return this.t().nav.theme;
  }

  toggleTheme() {
    this.theme.cycleMode();
  }

  toggleLanguage() {
    this.language.setLang(this.language.lang() === 'zh-CN' ? 'en' : 'zh-CN');
  }
}
