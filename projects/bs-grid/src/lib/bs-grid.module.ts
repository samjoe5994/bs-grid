import { NgModule } from '@angular/core';
import { BsGridComponent } from './bs-grid.component';
import { BsDynamicHostDirective } from './engine/dynamic-host.directive';

/** Compatibility shell for NgModule apps. Standalone apps import BsGridComponent directly. */
@NgModule({
  imports: [BsGridComponent, BsDynamicHostDirective],
  exports: [BsGridComponent, BsDynamicHostDirective],
})
export class BsGridModule {}
