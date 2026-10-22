import {
  Directive,
  ElementRef,
  inject,
  Input,
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
  private initialized = false;
  private active = false;

  @Input()
  set appComposerWidthSourceActive(active: boolean) {
    this.active = active;
    if (this.initialized)
      this.geometry.setActive(this.host.nativeElement, active);
  }

  ngOnInit(): void {
    this.stopObserving = this.geometry.observe(this.host.nativeElement);
    this.initialized = true;
    this.geometry.setActive(this.host.nativeElement, this.active);
  }

  ngOnDestroy(): void {
    this.geometry.setActive(this.host.nativeElement, false);
    this.stopObserving?.();
  }
}
