import {
  Directive,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
} from '@angular/core';
import { ComposerGeometryService } from '../services/composer-geometry.service';

/** Declares the real chat-width source; measurement and CSS writes stay in the global service. */
@Directive({ selector: '[appComposerWidthSource]' })
export class ComposerWidthSourceDirective implements OnInit, OnDestroy {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly geometry = inject(ComposerGeometryService);
  private stopObserving?: () => void;

  ngOnInit(): void {
    this.stopObserving = this.geometry.observe(this.host.nativeElement);
  }

  ngOnDestroy(): void {
    this.stopObserving?.();
  }
}
