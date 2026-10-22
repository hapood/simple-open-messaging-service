import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatExpansionModule } from '@angular/material/expansion';
import { TranslocoService } from '@jsverse/transloco';
import { LanguageService } from '../../app/services/language.service';
import { ThemeService } from '../../app/services/theme.service';
import {
  DeploymentConfig,
  defaultsForMode,
  deploymentIssues,
  generateCompose,
  initialDeployment,
  publishedPort,
  randomPassword,
} from './compose-generator';
import { deploymentMessages, issueMessages } from './deployment-i18n';

@Component({
  selector: 'app-deployment-page',
  imports: [
    FormsModule,
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatButtonToggleModule,
    MatTooltipModule,
    MatExpansionModule,
  ],
  template: `
    <div class="tool" [class.rail-open]="!collapsed()">
      <!-- Navigation Sidebar (Fixed left, independent of scrolling) -->
      <nav
        class="sidebar"
        [class.collapsed]="collapsed()"
        [attr.aria-label]="t().nav.deploy"
      >
        <button
          class="rail-item toggle-btn"
          type="button"
          (click)="collapsed.set(!collapsed())"
          [attr.aria-label]="collapsed() ? t().nav.expand : t().nav.collapse"
        >
          <span class="icon">☰</span>
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
          <span class="icon">◫</span>
          @if (!collapsed()) {
            <span>{{ t().nav.chat }}</span>
          }
        </a>
        <a
          class="rail-item selected"
          routerLink="/deploy"
          aria-current="page"
          [title]="t().nav.deploy"
          [attr.aria-label]="t().nav.deploy"
        >
          <span class="icon">⚙</span>
          @if (!collapsed()) {
            <span>{{ t().nav.deploy }}</span>
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
            <span class="icon">{{ themeIcon() }}</span>
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
            <span class="icon">文</span>
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

      <!-- Main Scrollable Area -->
      <main class="main-content">
        <div class="workspace">
          <div class="form-container">
            <!-- Section 01: Deployment Environment -->
            <mat-card class="section-card" appearance="outlined">
              <mat-card-header>
                <div mat-card-avatar class="section-avatar">
                  <span class="step-num">1</span>
                </div>
                <mat-card-title>{{ t().environment }}</mat-card-title>
              </mat-card-header>

              <mat-card-content>
                <div class="field-row">
                  <mat-button-toggle-group
                    [value]="config().mode"
                    (change)="setMode($event.value)"
                    aria-label="Deployment mode"
                  >
                    <mat-button-toggle value="public">{{
                      t().public
                    }}</mat-button-toggle>
                    <mat-button-toggle value="nas">{{
                      t().nas
                    }}</mat-button-toggle>
                  </mat-button-toggle-group>
                </div>

                @if (config().mode === 'public') {
                  <div class="ports-summary">{{ t().publicPorts }}</div>
                } @else {
                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().port }}</mat-label>
                      <input
                        matInput
                        name="port"
                        type="number"
                        min="1"
                        max="65535"
                        required
                        [ngModel]="config().port"
                        (ngModelChange)="update('port', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().portHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>
                }

                <div class="toggle-row">
                  <mat-slide-toggle
                    name="adminAccess"
                    [checked]="config().adminAccess === 'lan'"
                    (change)="
                      update('adminAccess', $event.checked ? 'lan' : 'public')
                    "
                  >
                    {{ t().adminOnly }}
                  </mat-slide-toggle>
                  <button
                    mat-icon-button
                    type="button"
                    class="row-help-btn small"
                    [matTooltip]="t().adminHint"
                    aria-label="Help"
                  >
                    ?
                  </button>
                </div>
              </mat-card-content>
            </mat-card>

            <!-- Section 02: Basics -->
            <mat-card class="section-card" appearance="outlined">
              <mat-card-header>
                <div mat-card-avatar class="section-avatar">
                  <span class="step-num">2</span>
                </div>
                <mat-card-title>{{ t().basic }}</mat-card-title>
              </mat-card-header>

              <mat-card-content>
                <h4 class="sub-heading">{{ t().domains }}</h4>

                <div class="input-row-with-help">
                  <mat-form-field appearance="outline" class="flex-field">
                    <mat-label>{{ t().domain }}</mat-label>
                    <input
                      matInput
                      name="domain"
                      required
                      [placeholder]="'example.com'"
                      [ngModel]="config().domain"
                      (ngModelChange)="update('domain', $event)"
                      spellcheck="false"
                    />
                  </mat-form-field>
                  <button
                    mat-icon-button
                    type="button"
                    class="row-help-btn"
                    [matTooltip]="t().domainHint"
                    aria-label="Help"
                  >
                    ?
                  </button>
                </div>

                <div class="input-row-with-help">
                  <mat-form-field appearance="outline" class="flex-field">
                    <mat-label>{{ t().webDomain }}</mat-label>
                    <input
                      matInput
                      name="webDomain"
                      required
                      [placeholder]="'soms.example.com'"
                      [ngModel]="config().webDomain"
                      (ngModelChange)="update('webDomain', $event)"
                      spellcheck="false"
                    />
                  </mat-form-field>
                  <button
                    mat-icon-button
                    type="button"
                    class="row-help-btn"
                    [matTooltip]="t().webDomainHint"
                    aria-label="Help"
                  >
                    ?
                  </button>
                </div>

                <div class="input-row-with-help">
                  <mat-form-field appearance="outline" class="flex-field">
                    <mat-label
                      >{{ t().lanDomain }} ({{ t().optional }})</mat-label
                    >
                    <input
                      matInput
                      name="lanDomain"
                      [placeholder]="'soms-lan.example.com'"
                      [ngModel]="config().lanDomain"
                      (ngModelChange)="update('lanDomain', $event)"
                      spellcheck="false"
                    />
                  </mat-form-field>
                  <button
                    mat-icon-button
                    type="button"
                    class="row-help-btn"
                    [matTooltip]="t().lanDomainHint"
                    aria-label="Help"
                  >
                    ?
                  </button>
                </div>

                <h4 class="sub-heading divider">{{ t().credentials }}</h4>

                <div class="input-row-with-help">
                  <mat-form-field appearance="outline" class="flex-field">
                    <mat-label>{{ t().adminPassword }}</mat-label>
                    <input
                      matInput
                      name="adminPassword"
                      required
                      type="text"
                      autocomplete="new-password"
                      [placeholder]="t().passwordHint"
                      [ngModel]="config().adminPassword"
                      (ngModelChange)="update('adminPassword', $event)"
                    />
                  </mat-form-field>
                  <button
                    mat-stroked-button
                    type="button"
                    class="generate-btn"
                    (click)="randomize('adminPassword')"
                  >
                    {{ t().random }}
                  </button>
                  <button
                    mat-icon-button
                    type="button"
                    class="row-help-btn"
                    [matTooltip]="t().adminPasswordHint"
                    aria-label="Help"
                  >
                    ?
                  </button>
                </div>
              </mat-card-content>
            </mat-card>

            <!-- Section 03: DNS & Certificates -->
            <mat-card class="section-card" appearance="outlined">
              <mat-card-header>
                <div mat-card-avatar class="section-avatar">
                  <span class="step-num">3</span>
                </div>
                <mat-card-title>{{ t().dnsAndCert }}</mat-card-title>
              </mat-card-header>

              <mat-card-content>
                <div class="input-row-with-help">
                  <mat-form-field appearance="outline" class="flex-field">
                    <mat-label>{{ t().dnsProvider }}</mat-label>
                    <mat-select
                      name="dnsProvider"
                      required
                      [ngModel]="config().dnsProvider"
                      (ngModelChange)="update('dnsProvider', $event)"
                    >
                      <mat-option value="cloudflare">{{
                        t().providerCloudflare
                      }}</mat-option>
                      <mat-option value="alidns">{{
                        t().providerAlidns
                      }}</mat-option>
                      <mat-option value="tencentcloud">{{
                        t().providerTencentcloud
                      }}</mat-option>
                    </mat-select>
                  </mat-form-field>
                  <button
                    mat-icon-button
                    type="button"
                    class="row-help-btn"
                    [matTooltip]="t().dnsProviderHint"
                    aria-label="Help"
                  >
                    ?
                  </button>
                </div>

                @if (config().dnsProvider === 'cloudflare') {
                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().dnsToken }}</mat-label>
                      <input
                        matInput
                        name="dnsToken"
                        required
                        type="text"
                        autocomplete="new-password"
                        [ngModel]="config().dnsToken"
                        (ngModelChange)="update('dnsToken', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().dnsTokenHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>
                }

                @if (config().dnsProvider === 'alidns') {
                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().aliyunKeyId }}</mat-label>
                      <input
                        matInput
                        name="aliyunKeyId"
                        required
                        type="text"
                        autocomplete="new-password"
                        [ngModel]="config().aliyunKeyId"
                        (ngModelChange)="update('aliyunKeyId', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().aliyunKeyIdHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>

                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().aliyunKeySecret }}</mat-label>
                      <input
                        matInput
                        name="aliyunKeySecret"
                        required
                        type="text"
                        autocomplete="new-password"
                        [ngModel]="config().aliyunKeySecret"
                        (ngModelChange)="update('aliyunKeySecret', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().aliyunKeySecretHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>
                }

                @if (config().dnsProvider === 'tencentcloud') {
                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().tencentSecretId }}</mat-label>
                      <input
                        matInput
                        name="tencentSecretId"
                        required
                        type="text"
                        autocomplete="new-password"
                        [ngModel]="config().tencentSecretId"
                        (ngModelChange)="update('tencentSecretId', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().tencentSecretIdHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>

                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().tencentSecretKey }}</mat-label>
                      <input
                        matInput
                        name="tencentSecretKey"
                        required
                        type="text"
                        autocomplete="new-password"
                        [ngModel]="config().tencentSecretKey"
                        (ngModelChange)="update('tencentSecretKey', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().tencentSecretKeyHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>
                }
              </mat-card-content>
            </mat-card>

            <!-- Section 04: Advanced (Material Expansion Panel) -->
            <mat-accordion class="advanced-accordion">
              <mat-expansion-panel
                class="section-card advanced-panel"
                appearance="outlined"
                #advancedPanel
              >
                <mat-expansion-panel-header>
                  <mat-panel-title>
                    <div mat-card-avatar class="section-avatar">
                      <span class="step-num">4</span>
                    </div>
                    <span>{{ t().advanced }}</span>
                  </mat-panel-title>
                </mat-expansion-panel-header>

                <div class="advanced-body">
                  <!-- Database Password lives here, auto-generated by default -->
                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().databasePassword }}</mat-label>
                      <input
                        matInput
                        name="databasePassword"
                        required
                        type="text"
                        autocomplete="new-password"
                        [ngModel]="config().databasePassword"
                        (ngModelChange)="update('databasePassword', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-stroked-button
                      type="button"
                      class="generate-btn"
                      (click)="randomize('databasePassword')"
                    >
                      {{ t().random }}
                    </button>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().databasePasswordHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>

                  <!-- Database Name (Full row) -->
                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().database }}</mat-label>
                      <input
                        matInput
                        name="database"
                        required
                        [ngModel]="config().database"
                        (ngModelChange)="update('database', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().databaseHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>

                  <!-- Database User (Full row, separate from Database Name) -->
                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().databaseUser }}</mat-label>
                      <input
                        matInput
                        name="databaseUser"
                        required
                        [ngModel]="config().databaseUser"
                        (ngModelChange)="update('databaseUser', $event)"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().databaseHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>

                  <!-- Container Image -->
                  <div class="input-row-with-help">
                    <mat-form-field appearance="outline" class="flex-field">
                      <mat-label>{{ t().image }}</mat-label>
                      <input
                        matInput
                        name="image"
                        required
                        [ngModel]="config().image"
                        (ngModelChange)="update('image', $event)"
                        spellcheck="false"
                      />
                    </mat-form-field>
                    <button
                      mat-icon-button
                      type="button"
                      class="row-help-btn"
                      [matTooltip]="t().imageHint"
                      aria-label="Help"
                    >
                      ?
                    </button>
                  </div>
                </div>
              </mat-expansion-panel>
            </mat-accordion>
          </div>

          <!-- Output Panel (Right Side) -->
          <mat-card class="output-card" appearance="outlined">
            <div class="output-header">
              <span class="file-title">docker-compose.yml</span>
              <div class="actions">
                <button
                  mat-stroked-button
                  type="button"
                  (click)="copy()"
                  [disabled]="!valid()"
                >
                  {{ t().copy }}
                </button>
                <button
                  mat-flat-button
                  color="primary"
                  type="button"
                  (click)="download()"
                  [disabled]="!valid()"
                >
                  ↓ {{ t().download }}
                </button>
              </div>
            </div>

            <div class="tabs">
              <button
                class="tab-btn"
                type="button"
                [class.active]="tab() === 'yaml'"
                (click)="tab.set('yaml')"
              >
                {{ t().live }}
              </button>
              <button
                class="tab-btn"
                type="button"
                [class.active]="tab() === 'checklist'"
                (click)="tab.set('checklist')"
              >
                {{ t().checklist }}
              </button>
            </div>

            @if (failure()) {
              <div class="errors" role="alert">{{ t().templateError }}</div>
            } @else if (issues().length) {
              <!-- If any required field is missing, NO YAML is shown. Only errors. -->
              <div class="errors">
                <strong>{{ t().invalidTitle }}</strong>
                <p>{{ t().invalidHint }}</p>
                <ul class="error-list">
                  @for (key of issues(); track key) {
                    <li>
                      <button
                        type="button"
                        class="error-item-btn"
                        (click)="focusIssue(key, advancedPanel)"
                      >
                        <span class="badge">!</span>
                        <span class="err-text">{{ issue(key) }}</span>
                        <span class="arrow">→</span>
                      </button>
                    </li>
                  }
                </ul>
              </div>
            } @else if (!template()) {
              <div class="errors">{{ t().loading }}</div>
            } @else {
              <!-- Valid state: show YAML preview or deployment checklist -->
              @if (tab() === 'yaml') {
                <pre><code>{{ yaml() }}</code></pre>
              } @else {
                <div class="checklist">
                  <h3>{{ t().dnsStep }}</h3>
                  <p>{{ t().dnsHint }}</p>
                  <code
                    >{{ config().webDomain }} → YOUR_SERVER_IP<br />_somfp._tcp.{{
                      config().domain
                    }}. 300 IN SRV 10 0 {{ srvPort() }}
                    {{ config().webDomain }}.</code
                  >

                  <h3>{{ t().portsStep }}</h3>
                  <code>{{ portsSummary() }}</code>
                  <p>{{ t().portsHint }}</p>

                  <h3>{{ t().startStep }}</h3>
                  <code
                    >mkdir -p soms && cd soms<br /># Save docker-compose.yml
                    here<br />docker compose up -d<br />docker compose logs -f
                    app</code
                  >
                  <p>{{ t().startHint }}</p>

                  <h3>{{ t().verifyStep }}</h3>
                  <code>{{ verifyUrl() }}</code>
                  <p>{{ t().verifyHint }}</p>
                </div>
              }
            }

            <mat-card-footer class="output-footer">
              <p>{{ t().privacy }}</p>
              <p>{{ t().exportWarning }}</p>
              @if (notice(); as key) {
                <p class="notice" role="status">{{ t()[key] }}</p>
              }
            </mat-card-footer>
          </mat-card>
        </div>
      </main>
    </div>
  `,
  styles: `
    :host {
      display: block;
      height: 100vh;
      overflow: hidden;
      color: var(--app-text);
      background: var(--app-bg);
      font:
        14px/22px system-ui,
        -apple-system,
        sans-serif;
    }
    * {
      box-sizing: border-box;
    }
    p {
      margin: 0;
    }
    .tool {
      display: flex;
      height: 100%;
      overflow: hidden;
    }

    /* Fixed Navigation Sidebar */
    .sidebar {
      width: 190px;
      height: 100%;
      flex: none;
      padding: 14px 10px;
      background: var(--app-surface);
      border-right: 1px solid var(--app-border);
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: width 0.15s ease;
      z-index: 10;
    }
    .sidebar.collapsed {
      width: 60px;
      padding: 14px 6px;
    }
    .rail-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px;
      text-decoration: none;
      color: var(--app-text-muted);
      border: 0;
      background: transparent;
      border-radius: 8px;
      font: 13px/20px system-ui;
      white-space: nowrap;
      cursor: pointer;
      width: 100%;
      text-align: left;
    }
    .rail-item.selected {
      background: var(--app-selected);
      color: var(--app-text);
      font-weight: 550;
    }
    .rail-item .icon {
      width: 24px;
      flex: none;
      text-align: center;
      line-height: 20px;
      font-size: 15px;
    }
    .sidebar-footer {
      margin-top: auto;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .backdrop {
      display: none;
    }

    /* Main Independent Scrollable Workspace */
    .main-content {
      min-width: 0;
      flex: 1;
      height: 100%;
      overflow-y: auto;
      padding: 24px 32px;
    }
    .workspace {
      max-width: 1360px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(380px, 0.95fr) minmax(420px, 1.05fr);
      gap: 24px;
      align-items: start;
    }
    .form-container {
      display: flex;
      flex-direction: column;
      gap: 24px;
      min-width: 0;
    }

    /* Material Card Overrides */
    .section-card {
      border-radius: 12px !important;
      padding: 20px 24px !important;
      background: var(--app-surface) !important;
      border-color: var(--app-border) !important;
      box-shadow: var(--app-shadow-1, 0 1px 3px rgba(0, 0, 0, 0.04));
    }
    mat-card-header {
      padding: 0 !important;
      margin-bottom: 16px !important;
      display: flex !important;
      align-items: center !important;
    }
    mat-card-content {
      padding: 0 !important;
    }
    .section-avatar {
      width: 32px !important;
      height: 32px !important;
      border-radius: 50% !important;
      background: var(--app-bg-muted) !important;
      border: 1px solid var(--app-border) !important;
      display: grid !important;
      place-items: center !important;
      margin: 0 12px 0 0 !important;
      padding: 0 !important;
      flex: none;
    }
    .step-num {
      font:
        600 13px/20px system-ui,
        -apple-system,
        sans-serif;
      color: var(--app-action-primary);
    }
    mat-card-title {
      font-size: 15px !important;
      line-height: 22px !important;
      font-weight: 600 !important;
      letter-spacing: 0.15px !important;
      color: var(--app-text) !important;
      margin: 0 !important;
      padding: 0 !important; /* Eliminate side padding */
      display: flex !important;
      align-items: center !important;
    }

    /* Subheadings within cards */
    .sub-heading {
      font-size: 11px;
      line-height: 18px;
      font-weight: 600;
      color: var(--app-text-muted);
      margin: 4px 0 12px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }
    .sub-heading.divider {
      margin: 16px 0 12px;
      padding-top: 16px;
      border-top: 1px solid var(--app-border);
    }

    /* Input rows with Help Icon on the outer right */
    .input-row-with-help {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 6px;
      position: relative;
    }
    .flex-field {
      flex: 1;
      min-width: 0;
      margin-bottom: 0;
    }
    .row-help-btn {
      width: 36px !important;
      height: 36px !important;
      margin-top: 10px !important;
      border-radius: 50% !important;
      border: 1px solid var(--app-border) !important;
      background: var(--app-bg-muted) !important;
      color: var(--app-text-muted) !important;
      font: 500 13px/20px system-ui !important;
      display: grid !important;
      place-items: center !important;
      padding: 0 !important;
      flex: none;
      cursor: pointer;
      position: relative;
    }
    .row-help-btn:hover {
      background: var(--app-hover) !important;
      color: var(--app-text) !important;
      border-color: var(--app-border-strong, var(--app-border)) !important;
    }
    /* Restrict touch-target to avoid weird overlap/protrusion */
    .row-help-btn .mat-mdc-button-touch-target {
      width: 100% !important;
      height: 100% !important;
      transform: none !important;
      position: absolute !important;
      top: 0 !important;
      left: 0 !important;
    }

    .generate-btn {
      height: 54px !important;
      margin-top: 2px !important;
      border-radius: 8px !important;
      border-color: var(--app-border) !important;
      white-space: nowrap;
      flex: none;
    }

    .field-row {
      margin-bottom: 14px;
    }
    .toggle-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-top: 12px;
      padding-top: 12px;
      border-top: 1px solid var(--app-border);
    }
    .toggle-row .row-help-btn.small {
      margin-top: 0 !important;
      width: 24px !important;
      height: 24px !important;
      font-size: 11px !important;
    }

    .ports-summary {
      padding: 10px 14px;
      margin-bottom: 14px;
      background: var(--app-bg-muted);
      border-radius: 8px;
      font:
        12px/18px ui-monospace,
        monospace;
      color: var(--app-text);
      border: 1px solid var(--app-border);
    }

    /* Material Expansion Panel Styling for Section 04 */
    .advanced-accordion {
      display: block;
    }
    .advanced-panel {
      padding: 0 !important;
    }
    .advanced-panel mat-expansion-panel-header {
      padding: 16px 24px !important;
      font-family: inherit;
    }
    .advanced-panel mat-panel-title {
      display: flex;
      align-items: center;
      font-size: 15px;
      font-weight: 600;
      color: var(--app-text);
      margin: 0;
    }
    .advanced-body {
      padding: 0 24px 20px 24px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    /* Output Card on the Right */
    .output-card {
      padding: 0 !important;
      border-radius: 12px !important;
      background: var(--app-surface) !important;
      border-color: var(--app-border) !important;
      position: sticky;
      top: 0;
      overflow: hidden;
    }
    .output-header {
      padding: 12px 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--app-border);
      background: var(--app-surface);
    }
    .file-title {
      font:
        600 13px/20px ui-monospace,
        monospace;
      color: var(--app-text);
    }
    .actions {
      display: flex;
      gap: 8px;
    }

    .tabs {
      display: flex;
      gap: 20px;
      padding: 0 18px;
      border-bottom: 1px solid var(--app-border);
      background: var(--app-surface);
    }
    .tab-btn {
      border: 0;
      border-bottom: 2px solid transparent;
      padding: 10px 0;
      background: none;
      color: var(--app-text-muted);
      font: 500 13px/20px system-ui;
      cursor: pointer;
    }
    .tab-btn.active {
      color: var(--app-text);
      font-weight: 600;
      border-bottom-color: var(--app-action-primary);
    }

    /* Error checklist when invalid */
    .errors {
      padding: 24px 22px;
      min-height: 480px;
      background: var(--app-surface-sunken, var(--app-surface));
    }
    .errors strong {
      font-size: 14px;
      line-height: 22px;
      color: var(--app-text);
      display: block;
    }
    .errors p {
      color: var(--app-text-muted);
      font-size: 12px;
      line-height: 18px;
      margin: 6px 0 18px;
    }
    .error-list {
      list-style: none;
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .error-item-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      text-align: left;
      white-space: normal;
      width: 100%;
      border: 1px solid var(--app-border);
      background: var(--app-surface);
      color: var(--app-text);
      padding: 10px 14px;
      border-radius: 8px;
      cursor: pointer;
    }
    .error-item-btn:hover {
      background: var(--app-hover);
      border-color: var(--app-border-strong, var(--app-border));
    }
    .badge {
      width: 18px;
      height: 18px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: var(--app-danger-soft, rgba(211, 47, 47, 0.12));
      color: var(--app-danger, #d32f2f);
      font: 700 11px/18px monospace;
      flex: none;
    }
    .err-text {
      flex: 1;
      font-size: 12px;
    }
    .arrow {
      color: var(--app-text-muted);
      margin-left: auto;
    }

    /* Code & Checklist */
    pre {
      margin: 0;
      height: 520px;
      overflow: auto;
      padding: 20px;
      background: var(--app-surface-sunken, #0d1117);
      color: var(--app-text);
      font:
        11px/20px ui-monospace,
        SFMono-Regular,
        Menlo,
        monospace;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 20px;
    }
    .output-footer {
      padding: 12px 18px;
      border-top: 1px solid var(--app-border);
      color: var(--app-text-muted);
      font-size: 11px;
      line-height: 16px;
      background: var(--app-surface);
      margin: 0 !important;
    }
    .notice {
      color: var(--app-success, #2e7d32);
      margin-top: 6px;
      font-weight: 550;
    }
    .checklist {
      padding: 20px 22px;
      height: 520px;
      overflow: auto;
      font-size: 12px;
      line-height: 20px;
      color: var(--app-text-muted);
      background: var(--app-surface-sunken, var(--app-surface));
    }
    .checklist h3 {
      font-size: 13px;
      line-height: 20px;
      margin: 16px 0 6px;
      color: var(--app-text);
    }
    .checklist code {
      display: block;
      padding: 10px 12px;
      background: var(--app-surface);
      border: 1px solid var(--app-border);
      border-radius: 7px;
      margin: 6px 0;
      color: var(--app-text);
      overflow-wrap: anywhere;
    }

    @media (max-width: 1080px) {
      .workspace {
        grid-template-columns: 1fr;
      }
      .output-card {
        position: static;
      }
    }
    @media (max-width: 600px) {
      .sidebar {
        position: fixed;
        top: 0;
        bottom: 0;
        z-index: 30;
      }
      .main-content {
        padding: 14px 12px 24px 72px;
      }
      .rail-open .backdrop {
        display: block;
        position: fixed;
        inset: 0;
        background: var(--app-overlay, rgba(0, 0, 0, 0.5));
        z-index: 25;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeploymentPageComponent {
  readonly language = inject(LanguageService);
  readonly theme = inject(ThemeService);
  private readonly translator = inject(TranslocoService);

  readonly t = computed(() =>
    this.translator.translateObject<typeof deploymentMessages.en>(
      'deployment',
      {},
      this.language.lang(),
    ),
  );

  readonly config = signal<DeploymentConfig>({ ...initialDeployment });
  readonly collapsed = signal(
    typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 600px)').matches,
  );
  readonly tab = signal<'yaml' | 'checklist'>('yaml');
  readonly failure = signal(false);
  readonly notice = signal<'copied' | 'clipboardError' | 'downloaded' | null>(
    null,
  );

  readonly template = signal('');

  /** Issues list; if non-empty, YAML is strictly NOT rendered */
  readonly issues = computed(() => deploymentIssues(this.config()));
  readonly valid = computed(
    () => !!this.template() && !this.failure() && this.issues().length === 0,
  );
  readonly yaml = computed(() =>
    this.valid() ? generateCompose(this.template(), this.config()) : '',
  );

  constructor() {
    for (const [key, lang] of [
      ['en', 'en'],
      ['zh', 'zh-CN'],
    ] as const) {
      const errors = Object.fromEntries(
        Object.entries(issueMessages).map(([name, text]) => [
          name,
          text[key === 'zh' ? 0 : 1],
        ]),
      );
      this.translator.setTranslation(
        { deployment: { ...deploymentMessages[key], errors } },
        lang,
        { merge: true },
      );
    }
    void fetch(
      new URL('deployment-templates/nas/docker-compose.yml', document.baseURI),
    )
      .then(async (r) => {
        if (!r.ok) throw new Error('Template unavailable');
        const template = await r.text();
        generateCompose(template, {
          ...this.config(),
          domain: 'check.example.com',
          webDomain: 'soms.check.example.com',
          adminPassword: 'dummy-password-1234',
          dnsToken: 'dummy-token',
        });
        this.template.set(template);
      })
      .catch(() => this.failure.set(true));
  }

  themeIcon() {
    const mode = this.theme.effective();
    return mode === 'dark' ? '☾' : '☼';
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

  srvPort() {
    return publishedPort(this.config());
  }

  portsSummary() {
    return this.config().mode === 'public'
      ? '80/TCP · 443/TCP+UDP'
      : `${this.config().port}/TCP+UDP`;
  }

  verifyUrl() {
    const c = this.config();
    return `https://${c.webDomain}${c.mode === 'public' ? '' : ':' + c.port}/api/v1/config`;
  }

  issue(key: string) {
    return this.translator.translate(
      `deployment.errors.${key}`,
      {},
      this.language.lang(),
    );
  }

  focusIssue(key: string, expansionPanel: any) {
    if (
      ['database', 'databasePassword', 'databaseUser', 'image'].includes(key)
    ) {
      expansionPanel?.open();
    }
    const targetId = key === 'publicPort' ? 'port' : key;
    // Find input or select by name/id
    const target =
      document.getElementById(targetId) ||
      document.querySelector(`[name="${targetId}"]`) ||
      document.querySelector(`input[name="${targetId}"]`);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (target as HTMLElement).focus();
    }
  }

  toggleLanguage() {
    this.language.setLang(this.language.lang() === 'zh-CN' ? 'en' : 'zh-CN');
  }

  setMode(mode: DeploymentConfig['mode']) {
    this.config.update((c) => ({ ...c, mode, ...defaultsForMode(mode) }));
    this.notice.set(null);
  }

  update<K extends keyof DeploymentConfig>(key: K, value: DeploymentConfig[K]) {
    this.config.update((c) => ({ ...c, [key]: value }));
    this.notice.set(null);
  }

  randomize(key: 'databasePassword' | 'adminPassword') {
    this.update(key, randomPassword());
  }

  async copy() {
    if (!this.valid()) return;
    try {
      await navigator.clipboard.writeText(this.yaml());
      this.notice.set('copied');
    } catch {
      this.notice.set('clipboardError');
    }
  }

  download() {
    if (!this.valid()) return;
    const url = URL.createObjectURL(
      new Blob([this.yaml()], {
        type: 'application/yaml',
      }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = 'docker-compose.yml';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.notice.set('downloaded');
  }
}
