import { Injectable } from '@angular/core';
import { ColDef } from '../api/public-types';
import { Column, normalizePin } from './models/column.model';

const DEFAULT_WIDTH = 200;
export const AUTO_GROUP_COL_ID = 'ag-Grid-AutoColumn';

/**
 * ColumnService — owns the column model for one grid instance: builds Columns from
 * ColDefs (merged with defaultColDef), assigns stable colIds, computes per-region
 * layout (left | center | right) with cumulative `left` offsets, resolves flex/default
 * widths, and implements sizeColumnsToFit + column state serialize/apply.
 */
@Injectable()
export class ColumnService {
  columns: Column[] = [];
  private defaultColDef: ColDef = {};
  autoGroupColumnDef: ColDef = {};
  private autoGroupColumn: Column | null = null;

  // pivot
  pivotMode = false;
  generatedPivotColumns: Column[] = [];

  // region splits (visible columns only), recomputed by layout()
  leftColumns: Column[] = [];
  centerColumns: Column[] = [];
  rightColumns: Column[] = [];

  leftWidth = 0;
  centerWidth = 0;
  rightWidth = 0;

  /** Prefix-sum of center-column left offsets (centerLefts[i] = left of center col i;
   *  centerLefts[n] = centerWidth). Rebuilt by layout(); read by the column-virtualization
   *  window so scrolling doesn't reallocate it per frame (audit P3). */
  centerLefts: number[] = [0];

  setColumnDefs(colDefs: ColDef[], defaultColDef: ColDef = {}, opts?: { preserveState?: boolean }): void {
    this.defaultColDef = defaultColDef || {};
    // Preserve user/runtime column state (order, width, pin, sort, visibility, grouping) across a
    // columnDefs update — matching AG Grid, whose re-set keeps existing column state keyed by colId.
    // Without this, a late columnDefs reassignment (common once survey questions resolve) rebuilds
    // the columns in def order and silently discards a restored/persisted order. Reset opts out.
    const preserve = opts?.preserveState !== false && this.columns.length > 0;
    const prev = preserve ? new Map(this.columns.map(c => [c.colId, c])) : null;
    const prevOrder = preserve ? new Map(this.columns.map((c, i) => [c.colId, i])) : null;
    const usedIds = new Set<string>();
    let built = (colDefs || []).map((def, i) => {
      const merged: ColDef = { ...this.defaultColDef, ...def };
      const colId = uniqueId(merged.colId || merged.field || `col_${i}`, usedIds);
      const col = new Column(colId, merged);
      const p = prev?.get(colId);
      if (p) {
        // Pure UI state (user resize/pin/sort/visibility) always survives a columnDefs re-set.
        col.width = p.width; col.flex = p.flex; col.hide = p.hide; col.pinned = p.pinned;
        col.sort = p.sort; col.sortIndex = p.sortIndex;
        // Grouping/pivot/aggregation follow AG's stateful-attribute rule: a value DEFINED on the
        // new def is applied; undefined keeps the current state. The crosstab re-sets columnDefs
        // on every drag (a question moves Rows ↔ Columns, aggregations change) and those defs
        // always declare rowGroup/pivot/aggFunc — blindly keeping the previous state here froze
        // the cross-tab on its first configuration.
        col.rowGroup = merged.rowGroup !== undefined ? !!merged.rowGroup : p.rowGroup;
        col.rowGroupIndex = merged.rowGroupIndex !== undefined ? merged.rowGroupIndex : p.rowGroupIndex;
        col.pivot = merged.pivot !== undefined ? !!merged.pivot : p.pivot;
        col.pivotIndex = merged.pivotIndex !== undefined ? merged.pivotIndex : p.pivotIndex;
        col.aggFunc = merged.aggFunc !== undefined ? merged.aggFunc : p.aggFunc;
        // hide is declared on every crosstab source def too; def wins when specified.
        if (merged.hide !== undefined) col.hide = !!merged.hide;
      }
      return col;
    });
    if (prevOrder) {
      // Existing columns keep their previous (possibly user-reordered / persisted) order. Each
      // BRAND-NEW column is inserted at the position implied by the new defs — right after its
      // nearest preceding def-sibling — instead of being appended at the very end. This is what
      // makes toggled columns (a question's "-Score", "Expand Grid" per-option columns, added
      // variables/expressions) appear next to their parent question rather than dumped at the
      // end of the table. Processing new columns in def order chains adjacent new columns.
      const result: Column[] = built
        .filter(c => prevOrder.has(c.colId))
        .sort((a, b) => (prevOrder.get(a.colId) as number) - (prevOrder.get(b.colId) as number));
      built.forEach((col, i) => {
        if (prevOrder.has(col.colId)) return;      // existing — already placed above
        if (i === 0) { result.unshift(col); return; }
        const at = result.indexOf(built[i - 1]);   // def-predecessor (already placed by now)
        if (at === -1) result.push(col);
        else result.splice(at + 1, 0, col);
      });
      built = result;
    }
    this.columns = built;
  }

  get visibleColumns(): Column[] {
    return this.columns.filter(c => !c.hide);
  }

  /** Visible columns in on-screen left-to-right order (pinned-left, center, pinned-right).
   *  Only meaningful after layout() has run. Used by range selection to resolve a rectangle's
   *  column span independent of the underlying columns[] definition order. */
  get orderedVisibleColumns(): Column[] {
    return [...this.leftColumns, ...this.centerColumns, ...this.rightColumns];
  }

  getColumn(colId: string): Column | undefined {
    return this.columns.find(c => c.colId === colId);
  }

  // ---- row grouping ----
  getRowGroupColumns(): Column[] {
    return this.columns.filter(c => c.rowGroup).sort((a, b) => (a.rowGroupIndex ?? 0) - (b.rowGroupIndex ?? 0));
  }

  isGrouping(): boolean { return this.columns.some(c => c.rowGroup); }

  toggleRowGroup(colId: string): void {
    const col = this.getColumn(colId);
    if (!col) return;
    if (col.rowGroup) {
      col.rowGroup = false;
      col.rowGroupIndex = null;
    } else {
      col.rowGroup = true;
      col.rowGroupIndex = this.getRowGroupColumns().length;
    }
  }

  removeAllRowGroups(): void {
    for (const c of this.columns) { c.rowGroup = false; c.rowGroupIndex = null; }
  }

  // ---- pivot ----
  getPivotColumns(): Column[] {
    return this.columns.filter(c => c.pivot).sort((a, b) => (a.pivotIndex ?? 0) - (b.pivotIndex ?? 0));
  }
  getValueColumns(): Column[] { return this.columns.filter(c => !!c.aggFunc); }

  /**
   * Build generated cross-tab columns: one per (pivot key combo × value column). A pivot key
   * is the ordered tuple of display values across ALL pivot columns (AG-style multi-pivot),
   * e.g. two column-questions yield one generated column per observed answer pair.
   */
  buildPivotColumns(pivotKeys: string[][], valueCols: Column[]): void {
    this.generatedPivotColumns = [];
    const multiVal = valueCols.length > 1;
    for (const keys of pivotKeys) {
      const groupLabel = keys.map(k => k || '(Blanks)').join(' / ');
      for (const vc of valueCols) {
        //  (unit separator) can't appear in survey answers, so generated colIds stay unique
        const col = new Column(`pv::${keys.join('')}::${vc.colId}`, {
          headerName: multiVal ? `${groupLabel} — ${vc.headerName}` : groupLabel,
          width: 120, sortable: false, filter: false, suppressMovable: true,
        });
        (col as any).pivotValueKeys = keys;
        (col as any).pivotValueCol = vc;
        (col as any).pivotGroupLabel = groupLabel;
        (col as any).pivotSubLabel = vc.headerName;
        this.generatedPivotColumns.push(col);
      }
    }
  }

  /** Replace the auto-group ColDef and drop the cached column so the next layout rebuilds it. */
  setAutoGroupColumnDef(def: ColDef): void {
    this.autoGroupColumnDef = def || {};
    this.autoGroupColumn = null;
  }

  /**
   * Columns as the user sees them, for export: in pivot mode the auto-group column + the
   * generated cross-tab columns; while grouping, the auto-group column + the remaining visible
   * columns; otherwise null (caller falls back to the plain column list).
   */
  getDisplayedColumnsForExport(): Column[] | null {
    if (this.pivotMode && this.generatedPivotColumns.length) {
      return [this.ensureAutoGroupColumn(), ...this.generatedPivotColumns];
    }
    if (this.isGrouping()) {
      return [this.ensureAutoGroupColumn(), ...this.visibleColumns.filter(c => !c.rowGroup && c.colId !== AUTO_GROUP_COL_ID)];
    }
    return null;
  }

  private ensureAutoGroupColumn(): Column {
    if (!this.autoGroupColumn) {
      this.autoGroupColumn = new Column(AUTO_GROUP_COL_ID, {
        headerName: 'Group', pinned: 'left', width: 240, sortable: false, filter: false,
        suppressMovable: true, ...this.autoGroupColumnDef,
      });
    }
    return this.autoGroupColumn;
  }

  /**
   * Compute region membership + widths + cumulative `left` offsets. Flex columns split
   * the leftover center width after fixed columns. Call whenever columns/visibility/
   * width/pin change or the viewport resizes.
   */
  layout(viewportWidth: number): void {
    const grouping = this.isGrouping();
    let visible: Column[];
    if (this.pivotMode && this.generatedPivotColumns.length) {
      // pivot: auto-group column (rows) + generated cross-tab columns (measures)
      const autoCol = this.ensureAutoGroupColumn();
      autoCol.hide = false;
      visible = [autoCol, ...this.generatedPivotColumns];
    } else {
      // hide the grouped source columns while grouping is active (AG Grid behavior)
      visible = this.visibleColumns.filter(c => !(grouping && c.rowGroup));
      if (grouping) {
        const autoCol = this.ensureAutoGroupColumn();
        autoCol.hide = false;
        visible = [autoCol, ...visible.filter(c => c.colId !== AUTO_GROUP_COL_ID)];
      }
    }
    this.leftColumns = visible.filter(c => c.pinned === 'left');
    this.rightColumns = visible.filter(c => c.pinned === 'right');
    this.centerColumns = visible.filter(c => c.pinned == null);

    // Resolve fixed widths. A column flexes ONLY inside the scrolling center region — flex splits
    // the center's leftover space (below). A PINNED column sits outside that region, so its flex
    // has nothing to distribute: treat pinned columns as fixed here. Without this, a pinned column
    // that carries a flex (e.g. from a defaultColDef `flex: 1`) but no explicit width falls through
    // both this loop and the center-flex loop, keeps width `undefined`, and renders as a collapsed
    // 0px pinned strip that hides the column's value entirely.
    for (const c of visible) {
      const flexesInCenter = c.flex != null && c.pinned == null;
      if (!flexesInCenter && !c.width) c.width = c.colDef.width ?? DEFAULT_WIDTH;
      if (c.width) c.width = clamp(c.width, c.minWidth, c.maxWidth);
    }

    this.leftWidth = this.assignLefts(this.leftColumns);
    this.rightWidth = this.assignLefts(this.rightColumns);

    // flex distribution across center columns
    const centerFixed = this.centerColumns.filter(c => c.flex == null);
    const centerFlex = this.centerColumns.filter(c => c.flex != null);
    const fixedWidth = centerFixed.reduce((s, c) => s + c.width, 0);
    if (centerFlex.length) {
      const avail = Math.max(0, viewportWidth - this.leftWidth - this.rightWidth - fixedWidth);
      const flexTotal = centerFlex.reduce((s, c) => s + (c.flex || 0), 0) || 1;
      for (const c of centerFlex) {
        c.width = clamp(Math.floor((avail * (c.flex || 0)) / flexTotal), c.minWidth, c.maxWidth) || c.minWidth;
      }
    }
    this.centerWidth = this.assignLefts(this.centerColumns);
    this.centerLefts = this.buildLefts(this.centerColumns);
  }

  private assignLefts(cols: Column[]): number {
    let x = 0;
    for (const c of cols) {
      c.left = x;
      x += c.width || 0;
    }
    return x;
  }

  /** Prefix-sum array of a column list's left offsets (length = cols.length + 1). */
  private buildLefts(cols: Column[]): number[] {
    const lefts = new Array(cols.length + 1);
    let x = 0;
    for (let i = 0; i < cols.length; i++) { lefts[i] = x; x += cols[i].width || 0; }
    lefts[cols.length] = x;
    return lefts;
  }

  /** Distribute the full viewport width across non-pinned, non-suppressed columns. */
  sizeColumnsToFit(viewportWidth: number): void {
    const fitCols = this.centerColumns.filter(c => !c.colDef.suppressSizeToFit);
    if (!fitCols.length) return;
    const avail = Math.max(0, viewportWidth - this.leftWidth - this.rightWidth);
    const totalCurrent = fitCols.reduce((s, c) => s + (c.width || DEFAULT_WIDTH), 0) || 1;
    let used = 0;
    fitCols.forEach((c, i) => {
      if (i === fitCols.length - 1) {
        c.width = clamp(avail - used, c.minWidth, c.maxWidth);
      } else {
        const w = clamp(Math.floor((avail * (c.width || DEFAULT_WIDTH)) / totalCurrent), c.minWidth, c.maxWidth);
        c.width = w;
        used += w;
      }
    });
    this.centerWidth = this.assignLefts(this.centerColumns);
  }

  setPinned(colId: string, pinned: 'left' | 'right' | null): void {
    const col = this.getColumn(colId);
    if (!col || col.colDef.lockPinned) return;
    col.pinned = normalizePin(pinned);
  }

  moveColumn(colId: string, toIndex: number): void {
    const from = this.columns.findIndex(c => c.colId === colId);
    if (from === -1) return;
    const [col] = this.columns.splice(from, 1);
    this.columns.splice(toIndex, 0, col);
  }

  // ---- column state (undefined = keep, null = clear) ----
  getColumnState(): any[] {
    return this.columns.map(c => ({
      colId: c.colId,
      width: c.width,
      flex: c.flex ?? null,
      hide: c.hide,
      pinned: c.pinned,
      sort: c.sort,
      sortIndex: c.sortIndex,
      rowGroup: c.rowGroup,
      rowGroupIndex: c.rowGroupIndex,
      aggFunc: c.aggFunc,
      pivot: c.pivot,
      // AG parity: the crosstab's aggregation functions locate the column-question via
      // getColumnState().find(col => col.pivotIndex === 0).
      pivotIndex: c.pivot ? this.getPivotColumns().indexOf(c) : null,
    }));
  }

  applyColumnState(params: { state?: any[]; applyOrder?: boolean; defaultState?: any }): void {
    const { state = [], applyOrder, defaultState } = params || {};
    const apply = (col: Column, s: any) => {
      if ('width' in s && s.width != null) col.width = s.width;
      if ('flex' in s) col.flex = s.flex;
      if ('hide' in s && s.hide !== undefined) col.hide = !!s.hide;
      if ('pinned' in s && s.pinned !== undefined) col.pinned = normalizePin(s.pinned);
      if ('sort' in s && s.sort !== undefined) col.sort = s.sort;
      if ('sortIndex' in s && s.sortIndex !== undefined) col.sortIndex = s.sortIndex;
      if ('rowGroup' in s && s.rowGroup !== undefined) col.rowGroup = !!s.rowGroup;
      if ('rowGroupIndex' in s && s.rowGroupIndex !== undefined) col.rowGroupIndex = s.rowGroupIndex;
      if ('aggFunc' in s && s.aggFunc !== undefined) col.aggFunc = s.aggFunc;
      if ('pivot' in s && s.pivot !== undefined) col.pivot = !!s.pivot;
      if ('pivotIndex' in s && s.pivotIndex !== undefined) col.pivotIndex = s.pivotIndex;
    };
    const named = new Set<string>();
    for (const s of state) {
      const col = this.getColumn(s.colId);
      if (col) { apply(col, s); named.add(col.colId); }
    }
    if (defaultState) {
      for (const col of this.columns) if (!named.has(col.colId)) apply(col, defaultState);
    }
    if (applyOrder && state.length) {
      const order = new Map(state.map((s, i) => [s.colId, i]));
      this.columns.sort((a, b) => (order.get(a.colId) ?? 1e9) - (order.get(b.colId) ?? 1e9));
    }
  }

  resetColumnState(originalDefs: ColDef[]): void {
    this.setColumnDefs(originalDefs, this.defaultColDef, { preserveState: false });
  }
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base, i = 1;
  while (used.has(id)) id = `${base}_${i++}`;
  used.add(id);
  return id;
}

function clamp(v: number, min: number, max: number | null): number {
  v = Math.max(v, min ?? 0);
  if (max != null) v = Math.min(v, max);
  return v;
}
