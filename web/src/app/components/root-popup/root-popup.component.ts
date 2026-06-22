import { Component, Signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { RouteService, DlgInfo } from '../../services/route.service';
import { MaterialDialogComponent } from '../material-dialog/material-dialog.component';

@Component({
    selector: 'app-root-popup',
    imports: [MaterialDialogComponent, NgComponentOutlet],
    templateUrl: './root-popup.component.html',
    styleUrl: './root-popup.component.scss'
})
export class RootPopupComponent {
  dlgList: Signal<DlgInfo[]>

  constructor(private routeService: RouteService) {
    this.dlgList = this.routeService.dlgList
  }

}
