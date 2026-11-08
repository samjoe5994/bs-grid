import { Injectable } from '@angular/core';
import { RowNode } from './models/row-node.model';

export type SelectionMode = 'single' | 'multiple';

/**
 * SelectionService — models selection as a Set of stable row ids (never object refs, so
 * it survives data refresh and works with lazy models). Supports single vs multi mode,
 * ctrl-toggle, shift-range against a click anchor, header tri-state over a scope
 * (all | filtered), and isRowSelectable gating. Pure JS — SSR-safe.
 */
@Injectable()
export class SelectionService {
  private selectedIds = new Set<string>();
  anchorIndex: number | null = null;
  mode: SelectionMode = 'multiple';
  filteredOnlyHeader = true;

  /** provided by the grid: the current display list (post filter+sort). */
  getDisplayed: () => RowNode[] = () => [];
  isRowSelectable: (node: RowNode) => boolean = (n) => n.selectable;

  isSelected(node: RowNode): boolean { return this.selectedIds.has(node.id); }
  getSelectedIds(): Set<string> { return this.selectedIds; }
  count(): number { return this.selectedIds.size; }

  /** apply current selection to node.selected flags (called after refresh). */
  syncNodes(nodes: RowNode[]): void {
    for (const n of nodes) n.selected = this.selectedIds.has(n.id);
  }

  /**
   * Drop selected ids that no longer exist in the given node set. Called after the row data is
   * replaced (e.g. deleting responses) so the "Selected: N" count and header tri-state reflect
   * only rows that still exist — otherwise a deleted-but-selected id lingers and the count stays.
   */
  pruneTo(nodes: RowNode[]): void {
    if (!this.selectedIds.size) return;
    const alive = new Set(nodes.map(n => n.id));
    for (const id of Array.from(this.selectedIds)) {
      if (!alive.has(id)) this.selectedIds.delete(id);
    }
    if (this.anchorIndex != null && this.anchorIndex >= nodes.length) this.anchorIndex = null;
  }

  setSelected(node: RowNode, value: boolean): void {
    if (value && !this.isRowSelectable(node)) return;
    if (value) {
      if (this.mode === 'single') this.selectedIds.clear();
      this.selectedIds.add(node.id);
    } else {
      this.selectedIds.delete(node.id);
    }
    node.selected = value;
  }

  toggle(node: RowNode): void { this.setSelected(node, !this.isSelected(node)); }

  /**
   * Handle a row/checkbox click with modifier semantics. Returns true if selection changed.
   */
  handleClick(node: RowNode, index: number, opts: { ctrl?: boolean; shift?: boolean; fromCheckbox?: boolean }): boolean {
    const displayed = this.getDisplayed();
    if (this.mode === 'single') {
      this.selectedIds.clear();
      if (this.isRowSelectable(node)) this.selectedIds.add(node.id);
      this.anchorIndex = index;
    } else if (opts.shift && this.anchorIndex != null) {
      const [a, b] = [this.anchorIndex, index].sort((x, y) => x - y);
      if (!opts.ctrl && !opts.fromCheckbox) this.selectedIds.clear();
      for (let i = a; i <= b; i++) {
        const n = displayed[i];
        if (n && this.isRowSelectable(n)) this.selectedIds.add(n.id);
      }
    } else if (opts.ctrl || opts.fromCheckbox) {
      this.toggle(node);
      this.anchorIndex = index;
    } else {
      this.selectedIds.clear();
      if (this.isRowSelectable(node)) this.selectedIds.add(node.id);
      this.anchorIndex = index;
    }
    this.syncNodes(displayed);
    return true;
  }

  // ---- header select-all ----
  private headerScope(): RowNode[] {
    // filtered-only => the current display list; else all is also the display list for CSRM
    return this.getDisplayed().filter(n => this.isRowSelectable(n));
  }

  headerState(): 'checked' | 'unchecked' | 'indeterminate' {
    const scope = this.headerScope();
    if (!scope.length) return 'unchecked';
    let sel = 0;
    for (const n of scope) if (this.selectedIds.has(n.id)) sel++;
    if (sel === 0) return 'unchecked';
    if (sel === scope.length) return 'checked';
    return 'indeterminate';
  }

  toggleAll(): void {
    const scope = this.headerScope();
    const state = this.headerState();
    if (state === 'checked') {
      for (const n of scope) this.selectedIds.delete(n.id);
    } else {
      for (const n of scope) this.selectedIds.add(n.id);
    }
    this.syncNodes(this.getDisplayed());
  }

  selectAll(): void {
    for (const n of this.headerScope()) this.selectedIds.add(n.id);
    this.syncNodes(this.getDisplayed());
  }

  deselectAll(): void {
    this.selectedIds.clear();
    this.syncNodes(this.getDisplayed());
  }
}
