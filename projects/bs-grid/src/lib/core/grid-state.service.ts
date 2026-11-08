import { Injectable, NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { BsCellParams, ColDef, GridOptions } from '../api/public-types';
import { ColumnService } from './column.service';
import { Column } from './models/column.model';
import { RowNode } from './models/row-node.model';
import { ClientSideRowModel } from './row-model/client-side-row-model';
import { ExportService } from './export.service';
import { FilterService } from './filter/filter.service';
import { RangeSelectionService } from './range-selection.service';
import { SelectionService } from './selection.service';
import { SortService } from './sort.service';
import { ValueService } from './value.service';

/**
 * GridStateService — the per-instance hub. Wires ColumnService + ValueService +
 * SortService + row model together, holds GridOptions, and emits a single `changed$`
 * signal the view subscribes to. One instance per <bs-grid> (component-level provider),
 * so multiple grids on a screen stay isolated.
 */
@Injectable()
export class GridStateService {
  options: GridOptions = {};
  api: any = null; // GridApi, set by the facade
  view: any = null; // BsGridComponent, for imperative hooks needing the DOM/viewport

  rowModel!: ClientSideRowModel;
  private originalColDefs: ColDef[] = [];

  /** fires whenever the display list, columns, sort, or filter changes. */
  readonly changed$ = new Subject<void>();

  constructor(
    public columns: ColumnService,
    public values: ValueService,
    public sort: SortService,
    public filter: FilterService,
    public selection: SelectionService,
    public rangeSelection: RangeSelectionService,
    public exportService: ExportService,
    private zone: NgZone,
  ) {
    // ValueService builds params without a cycle back to us.
    this.values.buildBaseParams = (node: RowNode, column: Column): BsCellParams => ({
      value: undefined,
      data: node.data,
      node,
      colDef: column.colDef,
      column,
      rowIndex: node.rowIndex,
      api: this.api,
      context: this.options['context'],
      getValue: (field: string) => {
        const c = this.columns.getColumn(field) || this.columns.columns.find(x => x.colDef.field === field);
        return c ? this.values.getValue(c, node) : node.data?.[field];
      },
    });
  }

  init(options: GridOptions): void {
    this.options = options || {};
    this.values.valueCacheEnabled = !!this.options.valueCache;
    this.originalColDefs = this.options.columnDefs || [];
    this.columns.setColumnDefs(this.originalColDefs, this.options.defaultColDef);
    this.columns.autoGroupColumnDef = this.options['autoGroupColumnDef'] || {};

    // external filter hooks from gridOptions (crosstab)
    this.filter.isExternalFilterPresent = this.options.isExternalFilterPresent;
    this.filter.doesExternalFilterPass = this.options.doesExternalFilterPass;

    this.rowModel = new ClientSideRowModel(this.options, this.sort, this.values);
    this.rowModel.nodeState = this;
    this.rowModel.getColumns = () => this.columns.columns;
    this.rowModel.getGroupColumns = () => this.columns.getRowGroupColumns();
    this.rowModel.getApi = () => this.api;
    this.rowModel.grandTotalRow = this.options['grandTotalRow'] ?? null;
    this.rowModel.suppressAggFuncInHeader = !!this.options['suppressAggFuncInHeader'];
    this.columns.pivotMode = !!this.options['pivotMode'];
    this.rowModel.suppressLeafRows = this.columns.pivotMode;
    this.rebuildFilterPass();

    // selection config
    this.selection.mode = this.options.rowSelection === 'single' ? 'single' : 'multiple';
    this.selection.getDisplayed = () => this.rowModel.getDisplayedNodes();
    this.selection.isRowSelectable = (n) =>
      this.options.isRowSelectable ? !!this.options.isRowSelectable(n) : n.selectable;
    this.rangeSelection.enabled = !!this.options['enableRangeSelection'];

    this.rowModel.setRowData(this.options.rowData || []);
    // Pivot config supplied entirely at init (pivotMode + pivot/rowGroup/aggFunc colDefs)
    // must produce the cross-tab immediately, not wait for a later setColumnDefs call.
    if (this.columns.pivotMode) this.applyPivot();
  }

  // Pivot-key cache (audit P1). distinctPivotKeys re-scans every filtered row + re-sorts the
  // distinct tuples, and the crosstab fires 2-3 applyPivot()s per drag (setColumnDefs +
  // onFilterChanged + setRowData) with identical inputs. Cache the last result; drop it on ANY
  // structural change (columns, filter predicate, or a new rowData reference) so a cache hit can
  // only ever return a result computed against the current rows/filter/pivot-columns.
  private pivotKeyCache: { sig: string; combos: string[][] } | null = null;
  private lastRowDataRef: any = undefined;
  private invalidatePivotKeys(): void { this.pivotKeyCache = null; }

  /** rebuild the doesPass predicate from the current filter model + refresh nothing. */
  rebuildFilterPass(): void {
    const pass = this.filter.buildPass(this.columns.columns);
    this.rowModel.doesPass = pass;
    this.invalidatePivotKeys();   // the set of rows passing the filter changed
  }

  /** apply the current filter model: rebuild predicate, re-run the display list, emit. */
  applyFilter(): void {
    // A filtered-out row shifts every row after it to a new display index — an active cell
    // range's row bounds would silently point at different data, so drop it (AG parity).
    this.rangeSelection.clear();
    this.rebuildFilterPass();
    // AG parity: pivot result columns are derived from the rows that pass the filter, so a
    // filter change must regenerate them (a fully filtered-out answer drops its column).
    if (this.columns.pivotMode) { this.applyPivot(); return; }
    this.rowModel.refresh();
    this.emit();
  }

  /** toggle grouping by a column, relayout, and rebuild the display list. */
  toggleRowGroup(colId: string): void {
    this.rangeSelection.clear();   // grouping reshuffles the display list — row indices go stale
    this.columns.toggleRowGroup(colId);
    if (this.columns.pivotMode) this.applyPivot(); else { this.rowModel.refresh(); this.emit(); }
  }

  /** set pivot mode on/off and rebuild the cross-tab. */
  setPivotMode(on: boolean): void {
    this.columns.pivotMode = on;
    this.applyPivot();
  }

  /**
   * Recompute the pivot cross-tab: distinct pivot key tuples (across ALL pivot columns, from
   * rows passing the current filter — AG parity) → generated columns; group by the rowGroup
   * columns; aggregate value columns per (group × pivot key). Row groups are optional: with
   * none, the row model shows a single aggregated Total row. No-op (clears generated columns)
   * when pivot is off or there is no pivot/value column.
   */
  applyPivot(): void {
    const pivotCols = this.columns.getPivotColumns();
    const valueCols = this.columns.getValueColumns();
    this.rowModel.suppressLeafRows = this.columns.pivotMode;
    if (this.columns.pivotMode && pivotCols.length && valueCols.length) {
      const combos = this.distinctPivotKeys(pivotCols);
      this.columns.buildPivotColumns(combos, valueCols);
      this.rowModel.pivotColumns = pivotCols;
      this.rowModel.getPivotColumns = () => this.columns.generatedPivotColumns;
    } else {
      this.columns.generatedPivotColumns = [];
      this.rowModel.pivotColumns = [];
      this.rowModel.getPivotColumns = () => [];
    }
    this.rowModel.grandTotalRow = this.options['grandTotalRow'] ?? this.rowModel.grandTotalRow;
    this.rowModel.refresh();
    this.emit();
  }

  /** Ordered distinct pivot key tuples observed in the rows that pass the current filter. */
  private distinctPivotKeys(pivotCols: Column[]): string[][] {
    // Signature guards the one case the invalidation hooks don't cover: the pivot COLUMN SET
    // changing without a setColumnDefs (e.g. applyColumnState toggling a pivot flag).
    const sig = pivotCols.map(c => c.colId).join('|');
    if (this.pivotKeyCache && this.pivotKeyCache.sig === sig) return this.pivotKeyCache.combos;
    const seen = new Map<string, string[]>();
    for (const n of this.rowModel.getAllNodes()) {
      if (!this.rowModel.doesPass(n)) continue;
      const keys = pivotCols.map(pc => String(this.values.getDisplayValue(pc, n) ?? ''));
      const id = keys.join('');
      if (!seen.has(id)) seen.set(id, keys);
    }
    const combos = Array.from(seen.values()).sort((a, b) => {
      for (let i = 0; i < a.length; i++) {
        const cmp = a[i].localeCompare(b[i], undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
    this.pivotKeyCache = { sig, combos };
    return combos;
  }

  setColumnDefs(colDefs: ColDef[]): void {
    this.originalColDefs = colDefs || [];
    this.rangeSelection.clear();   // a range's colIds may no longer exist / mean the same thing
    this.invalidatePivotKeys();   // a pivot col's value expression / the pivot set may have changed
    this.columns.setColumnDefs(this.originalColDefs, this.options.defaultColDef);
    // Column defs changed, so a colId may now resolve to a different value expression
    // (e.g. the responses grid reuses field-derived colId "q1" for a non-getter column and,
    // after "Expand Grid", for a per-option valueGetter column). The per-node value cache is
    // keyed only by colId, so without clearing it the new column returns the previous column's
    // memoized value — surfacing as a stale raw object ("[object Object]"). Invalidate it here.
    if (this.values.valueCacheEnabled) {
      for (const n of this.rowModel.getAllNodes()) n.valueCache?.clear();
    }
    if (this.columns.pivotMode) { this.applyPivot(); return; }
    this.rowModel.refresh();
    this.emit();
  }

  setRowData(rowData: any[]): void {
    // Only a genuinely new rows array invalidates the pivot keys — the crosstab re-sets the SAME
    // array reference on every drag, and keeping the cache there is what collapses its duplicate
    // applyPivot() calls (audit P1).
    if (rowData !== this.lastRowDataRef) {
      this.invalidatePivotKeys();
      this.lastRowDataRef = rowData;
      // A genuinely new rows array (not a same-reference re-set some screens do on every
      // drag/refresh) means an active range's row indices may no longer point at the same data.
      this.rangeSelection.clear();
    }
    this.options.rowData = rowData;
    this.rowModel.setRowData(rowData || []);
    // Rows may have been removed (e.g. deleting responses); drop selection ids that no longer
    // exist so the status-bar "Selected" count and header checkbox reflect only live rows.
    this.selection.pruneTo(this.rowModel.getAllNodes());
    if (this.columns.pivotMode) { this.applyPivot(); return; }
    this.emit();
  }

  getOriginalColDefs(): ColDef[] { return this.originalColDefs; }

  emit(): void {
    // keep grid mutations inside Angular so the view updates
    if (NgZone.isInAngularZone()) this.changed$.next();
    else this.zone.run(() => this.changed$.next());
  }
}
