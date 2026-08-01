import { Component, HostListener, Signal, effect, inject, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { trigger, transition, state, style, animate } from '@angular/animations';
import { A11yModule } from '@angular/cdk/a11y';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouteService, DlgInfo } from '../../services/route.service';
import { MaterialDialogComponent } from '../material-dialog/material-dialog.component';
import { LayoutService } from '../../services/layout.service';
import { NavStateMachineService } from '../../services/nav-state.service';

// Shared motion policy for routed popups. Medium/expanded always render a centered card; compact page
// surfaces mount immediately, modal cards scale+fade, and immersive viewers fade. This rendering layer
// does not own navigation: :leave merely retains animated nodes while NavStateMachineService remains the
// source of truth for close/back.
const ENTER = '300ms cubic-bezier(0.32, 0.72, 0, 1)';
const LEAVE = '200ms cubic-bezier(0.4, 0, 1, 1)';

const dialogAnim = trigger('dialogAnim', [
  // Rest states. Desktop cards and compact modals are centered via translate(-50%, -50%), so scale must
  // preserve that offset. Page and viewer surfaces fill the compact viewport and rest at the origin.
  state('desktop', style({ opacity: 1, transform: 'translate(-50%, -50%) scale(1)' })),
  state('page', style({ opacity: 1, transform: 'none' })),
  state('modal', style({ opacity: 1, transform: 'translate(-50%, -50%) scale(1)' })),
  state('viewer', style({ opacity: 1, transform: 'none' })),

  transition('void => desktop', [
    style({ opacity: 0, transform: 'translate(-50%, -50%) scale(0.96)' }),
    animate(ENTER),
  ]),
  transition('void => modal', [
    style({ opacity: 0, transform: 'translate(-50%, -50%) scale(0.96)' }),
    animate(ENTER),
  ]),
  transition('desktop => void', [
    animate(LEAVE, style({ opacity: 0, transform: 'translate(-50%, -50%) scale(0.98)' })),
  ]),
  transition('modal => void', [
    animate(LEAVE, style({ opacity: 0, transform: 'translate(-50%, -50%) scale(0.98)' })),
  ]),
]);

@Component({
    selector: 'app-root-popup',
    imports: [A11yModule, MaterialDialogComponent, NgComponentOutlet, TranslocoPipe],
    animations: [dialogAnim],
    templateUrl: './root-popup.component.html',
    styleUrl: './root-popup.component.scss'
})
export class RootPopupComponent {
  dlgList: Signal<DlgInfo[]>
  /** Retains the closing dialog's mode after dlgList becomes empty, so MaterialDialog can choose the
   * correct backdrop exit behavior during that same render pass. */
  protected readonly instantBackdropHide = signal(false)
  // Medium/expanded render popups as centered cards; compact uses a full-screen overlay.
  protected readonly isCard = inject(LayoutService).isAtLeastMedium
  private readonly nav = inject(NavStateMachineService)

  constructor(private routeService: RouteService) {
    this.dlgList = this.routeService.dlgList
    effect(() => {
      const top = this.dlgList().at(-1)
      if (top) this.instantBackdropHide.set(!this.isCard() && top.presentation === 'page')
    })
    // A browser text selection belongs to the document rather than to a dialog. Without explicitly
    // releasing it, opening/closing a stacked dialog can leave highlighted text visible on the newly
    // exposed surface. Track the top entry (not merely the stack length) so sibling replacements clear it
    // too; the initial empty state is intentionally a no-op.
    let previousTopId: number | undefined
    effect(() => {
      const topId = this.dlgList().at(-1)?.id
      if (previousTopId !== undefined && topId !== previousTopId) {
        document.getSelection()?.removeAllRanges()
      }
      previousTopId = topId
    })
  }

  protected dialogState(info: DlgInfo): 'desktop' | 'page' | 'modal' | 'viewer' {
    return this.isCard() ? 'desktop' : info.presentation
  }

  @HostListener('document:keydown.escape', ['$event'])
  onEscape(event: KeyboardEvent): void {
    const stack = this.nav.paneStack()
    if (stack.at(-1)?.kind !== 'dialog') return
    event.preventDefault()
    event.stopPropagation()
    this.nav.back()
  }
}
