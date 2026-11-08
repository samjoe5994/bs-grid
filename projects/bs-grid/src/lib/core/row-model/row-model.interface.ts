import { RowNode } from '../models/row-node.model';

/**
 * IRowModel — the pluggable row-source abstraction. The grid engine consumes only this
 * interface, so a lazy `InfiniteRowModel` (block cache + datasource) can replace the
 * `ClientSideRowModel` later without touching any caller (see docs/bs-grid/SPEC.md B.4).
 */
export interface IRowModel {
  /** total rows in the display list (after filter/sort). */
  getRowCount(): number;
  /** row at a display index (may be undefined for not-yet-loaded lazy rows). */
  getRow(index: number): RowNode | undefined;
  getRowById(id: string): RowNode | undefined;

  /** all nodes regardless of filter/sort (client-side only). */
  forEachNode(cb: (node: RowNode, index: number) => void): void;
  /** nodes in display order after filter + sort. */
  forEachNodeAfterFilterAndSort(cb: (node: RowNode, index: number) => void): void;

  /** recompute the display list from source (re-run filter + sort). */
  refresh(): void;
}
