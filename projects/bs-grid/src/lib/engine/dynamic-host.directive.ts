import { Directive, ViewContainerRef } from '@angular/core';

/** Marks an insertion point where BsCellComponent mounts a dynamic renderer/editor. */
@Directive({ selector: '[bsDynamicHost]' })
export class BsDynamicHostDirective {
  constructor(public viewContainerRef: ViewContainerRef) {}
}
