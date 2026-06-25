import { Component, Signal, inject } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { RouteService, DlgInfo } from '../../services/route.service';
import { MaterialDialogComponent } from '../material-dialog/material-dialog.component';
import { LayoutService } from '../../services/layout.service';

@Component({
    selector: 'app-root-popup',
    imports: [MaterialDialogComponent, NgComponentOutlet],
    templateUrl: './root-popup.component.html',
    styleUrl: './root-popup.component.scss'
})
export class RootPopupComponent {
  dlgList: Signal<DlgInfo[]>
  // desktop renders popups as a centered card; mobile as a full-screen overlay.
  protected readonly isDesktop = inject(LayoutService).isDesktop

  constructor(private routeService: RouteService) {
    this.dlgList = this.routeService.dlgList
  }

}
