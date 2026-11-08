/**
 * RowNode — one per data row (and later per group/detail row). Identity comes from
 * getRowId(data) when provided, else the array index; a stable id is REQUIRED for
 * in-place editing, selection, and transactions to survive re-sorts and updates.
 */
export class RowNode<TData = any> {
  id: string;
  data: TData;

  /** display index after sort + filter. */
  rowIndex = 0;
  /** cumulative top offset in px (prefix-sum for variable heights). */
  rowTop = 0;
  rowHeight = 0;

  selected = false;
  selectable = true;

  // grouping
  level = 0;
  group = false;
  expanded = false;
  parent: RowNode<TData> | null = null;
  children: RowNode<TData>[] | null = null;
  /** group-row only: the group key (display value of the group column). */
  key: string | null = null;
  /**
   * group-row only: the field this level is grouped by (AG parity — the crosstab's custom
   * aggFuncs match rows via `key === params.rowNode.field`).
   */
  field: string | null = null;
  /** group-row only: the column this group is grouped by. */
  groupColumn: any = null;
  /** group-row only: all leaf descendants (for count + aggregation). */
  allLeafChildren: RowNode<TData>[] | null = null;
  childCount = 0;
  /** stable path used to persist expand/collapse across refreshes. */
  groupPath = '';
  /** group-row only: aggregated values by colId. */
  aggData: Record<string, any> | null = null;

  /** per-row memoized cell values (valueCache). */
  valueCache: Map<string, any> | null = null;

  constructor(id: string, data: TData) {
    this.id = id;
    this.data = data;
  }

  setSelected(v: boolean): void {
    this.selected = v;
  }

  // Back-reference to the owning grid's state, attached lazily by GridApi.getRowNode() so
  // setDataValue() can write through the value pipeline and refresh. Typed `any` to avoid a
  // module cycle (GridStateService → row model → RowNode → GridStateService).
  private gridState: any = null;
  attachState(state: any): void { this.gridState = state; }

  // ---- AG-Grid-compatible accessor API ----
  // Host callbacks (onRowSelected, isRowSelectable, …) call these on the node they receive.
  isSelected(): boolean { return this.selected; }
  isSelectable(): boolean { return this.selectable; }
  getData(): TData { return this.data; }
  getRowIndex(): number { return this.rowIndex; }

  /**
   * AG-compatible setDataValue(colKey, value): write one cell through the value pipeline
   * (valueSetter, else data[field]) and refresh the grid. BlockSurvey's contact-list uses it
   * to revert a cell after a failed edit. Accepts a colId string or a column-like object.
   * Falls back to a raw data write when the node isn't attached to a grid (e.g. obtained via
   * forEachNode rather than getRowNode).
   */
  setDataValue(colKey: any, value: any): boolean {
    const st = this.gridState;
    const colId = typeof colKey === 'string' ? colKey : colKey?.colId ?? colKey?.getColId?.();
    if (st) {
      const col = st.columns.getColumn(colId);
      if (col) {
        const changed = st.values.setValue(col, this, value);
        // In-place write keeps this node's identity, so force a cell refresh for OnPush cells.
        // AG setDataValue → change detection: re-aggregate and refresh cells, no re-sort/filter.
        if (changed) { st.rowModel.refreshAggregates(); st.view?.refreshCells?.(); st.emit(); }
        return changed;
      }
    }
    const field = colId ?? colKey?.field;
    if (field != null) { (this.data as any)[field] = value; this.valueCache?.clear(); }
    return true;
  }
}
