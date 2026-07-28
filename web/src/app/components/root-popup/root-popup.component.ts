import { Component, HostListener, Signal, inject } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { trigger, transition, state, style, animate } from '@angular/animations';
import { A11yModule } from '@angular/cdk/a11y';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouteService, DlgInfo } from '../../services/route.service';
import { MaterialDialogComponent } from '../material-dialog/material-dialog.component';
import { LayoutService } from '../../services/layout.service';
import { NavStateMachineService } from '../../services/nav-state.service';

// Enter/leave motion for routed popups. Medium/expanded render a centered card
// with a scale+fade; compact renders a slide-up sheet.
// (iOS feel). This is a pure rendering layer over the dlgList signal — the
// :leave transitions keep the node mounted until the exit animation finishes,
// so the back-button close contract in RouteService (system-back === button
// back, funneled through history.back()) is not touched.
const ENTER = '300ms cubic-bezier(0.32, 0.72, 0, 1)';
const LEAVE = '200ms cubic-bezier(0.4, 0, 1, 1)';

const dialogAnim = trigger('dialogAnim', [
  // Rest states. The desktop card is centered via translate(-50%, -50%), so its
  // scale must preserve that offset; the mobile sheet rests at the origin.
  state('desktop', style({ opacity: 1, transform: 'translate(-50%, -50%) scale(1)' })),
  state('mobile', style({ opacity: 1, transform: 'translateY(0)' })),

  transition('void => desktop', [
    style({ opacity: 0, transform: 'translate(-50%, -50%) scale(0.96)' }),
    animate(ENTER),
  ]),
  transition('void => mobile', [
    style({ opacity: 0, transform: 'translateY(100%)' }),
    animate(ENTER),
  ]),
  transition('desktop => void', [
    animate(LEAVE, style({ opacity: 0, transform: 'translate(-50%, -50%) scale(0.98)' })),
  ]),
  transition('mobile => void', [
    animate(LEAVE, style({ opacity: 0, transform: 'translateY(100%)' })),
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
  // Medium/expanded render popups as centered cards; compact uses a full-screen overlay.
  protected readonly isCard = inject(LayoutService).isAtLeastMedium
  private readonly nav = inject(NavStateMachineService)

  constructor(private routeService: RouteService) {
    this.dlgList = this.routeService.dlgList
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
