import { GridStateService } from '../core/grid-state.service';
import { Column } from '../core/models/column.model';
import { CellRange } from '../core/models/cell-range.model';
import { RowNode } from '../core/models/row-node.model';
import { ExcelMultipleSheetParams } from '../core/export.service';
import { ColDef } from './public-types';

/**
 * GridApi — the object emitted on (gridReady) and held in @ViewChild across the app.
 * Mirrors the AG Grid imperative surface BlockSurvey uses (see docs/bs-grid/SPEC.md A.2),
 * delegating to the per-instance services. Methods not yet implemented in the current
 * phase are present as no-ops/stubs so callers never throw during migration; they are
 * filled in as their phase lands.
 */
export class GridApi {
  private destroyed = false;

  constructor(private state: GridStateService) {}

  // ---- grid options ----
  setGridOption(key: string, value: any): void {
    if (key === 'columnDefs') { this.state.setColumnDefs(value); return; }
    if (key === 'rowData') { this.state.setRowData(value); return; }
    if (key === 'pivotMode') { this.state.setPivotMode(!!value); return; }
    if (key === 'autoGroupColumnDef') { this.state.columns.setAutoGroupColumnDef(value); this.state.emit(); return; }
    if (key === 'paginationPageSize') { this.state.view?.setPaginationPageSize(value); return; }
    if (key === 'grandTotalRow') { (this.state.options as any)[key] = value; this.state.rowModel.grandTotalRow = value; this.state.applyPivot(); return; }
    (this.state.options as any)[key] = value;
    this.state.emit();
  }
  setPivotMode(on: boolean): void { this.state.setPivotMode(on); }
  getGridOption(key: string): any { return (this.state.options as any)[key]; }

  // ---- columns / state ----
  /**
   * AG-compatible getColumn(colKey) → the Column (exposes getColId()/getColDef()) or null.
   * The results screen calls `api.getColumn(id)?.getColDef()` when labelling the applied-filter
   * chip; without this method that call threw "api.getColumn is not a function" on every
   * filter change (typing a text filter, or removing one filter while another stayed active).
   * Accepts a colId string or a column-like object, mirroring AG Grid, and falls back to field.
   */
  getColumn(colKey: string | any): Column | null {
    const colId = typeof colKey === 'string' ? colKey : colKey?.colId ?? colKey?.getColId?.();
    return this.state.columns.getColumn(colId)
      || this.state.columns.columns.find(c => c.colDef.field === colId)
      || null;
  }
  getColumnState(): any[] { return this.state.columns.getColumnState(); }
  applyColumnState(params: any): void {
    this.state.columns.applyColumnState(params);
    // state may change rowGroup/pivot/aggFunc — a pivoted grid must rebuild its cross-tab
    if (this.state.columns.pivotMode) { this.state.applyPivot(); return; }
    this.state.rowModel.refresh();
    this.state.emit();
  }
  resetColumnState(): void {
    this.state.columns.resetColumnState(this.state.getOriginalColDefs());
    if (this.state.columns.pivotMode) { this.state.applyPivot(); return; }
    this.state.rowModel.refresh();
    this.state.emit();
  }
  sizeColumnsToFit(): void { this.state.view?.hookSizeColumnsToFit(); }
  autoSizeColumns(keys?: any): void {
    const ids: string[] = Array.isArray(keys) ? keys.map((k: any) => (typeof k === 'string' ? k : k?.colId ?? k?.getColId?.())) : [];
    for (const id of ids) {
      const col = this.state.columns.getColumn(id);
      if (col) this.state.view?.autoSizeColumn(col);
    }
  }
  autoSizeAllColumns(): void { this.state.view?.autoSizeAllColumns(); }
  setColumnDefs(defs: ColDef[]): void { this.state.setColumnDefs(defs); }

  /**
   * AG-compatible getAllGridColumns() → every primary Column (visible or hidden), each
   * exposing getColId()/isVisible()/getColDef(). contact-list's refreshBadge counts hidden
   * columns and clearFilters re-shows them through this; without it both threw
   * "columnApi.getAllGridColumns is not a function" on grid-ready and every filter change.
   * (AG merged columnApi into api; the host aliases columnApi = params.api.)
   */
  getAllGridColumns(): Column[] { return this.state.columns.columns; }
  /** AG alias — some call sites use getColumns(). */
  getColumns(): Column[] { return this.state.columns.columns; }
  getAllDisplayedColumns(): Column[] { return this.state.columns.visibleColumns; }

  /**
   * AG-compatible setColumnsVisible(keys, visible): show/hide the named columns, then relayout.
   * A visibility change alters only column geometry (not rows), so emit() is enough — the view's
   * changed$ subscription re-runs layout + the column window.
   */
  setColumnsVisible(keys: any[], visible: boolean): void {
    const ids = (keys || []).map((k: any) => (typeof k === 'string' ? k : k?.colId ?? k?.getColId?.()));
    let changed = false;
    for (const id of ids) {
      const col = this.state.columns.getColumn(id);
      if (col && col.hide === visible) { col.hide = !visible; changed = true; }
    }
    if (changed) this.state.emit();
  }
  /** AG-compatible single-column form. */
  setColumnVisible(key: any, visible: boolean): void { this.setColumnsVisible([key], visible); }

  // ---- filter ----
  getFilterModel(): Record<string, any> { return this.state.filter.getModel(); }
  setFilterModel(model: any): void { this.state.filter.setModel(model); this.state.applyFilter(); }
  isAnyFilterPresent(): boolean { return this.state.filter.isAnyFilterPresent(); }
  isColumnFilterPresent(): boolean { return Object.keys(this.getFilterModel()).length > 0; }
  setQuickFilter(text: string): void { this.state.filter.setQuickFilter(text); this.state.applyFilter(); }
  onFilterChanged(): void { this.state.applyFilter(); }

  // ---- selection ----
  getSelectedNodes(): RowNode[] {
    return this.state.rowModel.getDisplayedNodes().filter(n => this.state.selection.isSelected(n));
  }
  getSelectedRows(): any[] { return this.getSelectedNodes().map(n => n.data); }
  selectAll(): void { this.state.selection.selectAll(); this.state.emit(); }
  deselectAll(): void { this.state.selection.deselectAll(); this.state.emit(); }
  setNodesSelected(params: { nodes: RowNode[]; newValue: boolean }): void {
    (params.nodes || []).forEach(n => this.state.selection.setSelected(n, params.newValue));
    this.state.emit();
  }

  // ---- cell range (AG v35 cellSelection) ----
  /** AG-compatible getCellRanges() — every currently-selected rectangular range (one, or
   *  several with multi-range Ctrl+drag selection), or []. */
  getCellRanges(): CellRange[] {
    return this.state.rangeSelection.getRanges();
  }
  /** AG-compatible addCellRange({rowStartIndex, rowEndIndex, columns}) — sets the range
   *  imperatively (as opposed to a user drag/shift-extend). */
  addCellRange(params: { rowStartIndex: number; rowEndIndex: number; columns: (string | any)[] }): void {
    const colIds = (params.columns || [])
      .map((c: any) => (typeof c === 'string' ? c : c?.colId ?? c?.getColId?.()))
      .filter((id: any): id is string => !!id);
    if (!colIds.length) return;
    this.state.rangeSelection.setOrderedColIds(this.state.columns.orderedVisibleColumns.map(c => c.colId));
    this.state.rangeSelection.setRange(params.rowStartIndex, params.rowEndIndex, colIds);
    this.state.view?.notifyCellSelectionChanged?.();
    this.state.emit();
  }
  clearCellSelection(): void {
    this.state.rangeSelection.clear();
    this.state.view?.notifyCellSelectionChanged?.();
    this.state.emit();
  }

  /**
   * AG-compatible getRowNode(id) → the RowNode with that getRowId value, or undefined.
   * contact-list uses it to revert a cell (rowNode.setDataValue) after a failed edit; we attach
   * the grid state to the returned node so its setDataValue() can write + refresh the view.
   */
  getRowNode(id: string): RowNode | undefined {
    const node = this.state.rowModel.getRowById(id);
    node?.attachState(this.state);
    return node;
  }

  // ---- iteration / export ----
  forEachNode(cb: (n: RowNode, i: number) => void): void { this.state.rowModel.forEachNode(cb); }
  forEachNodeAfterFilterAndSort(cb: (n: RowNode, i: number) => void): void { this.state.rowModel.forEachNodeAfterFilterAndSort(cb); }
  getRenderedNodes(): RowNode[] { return (this.state as any).renderedNodes ?? []; }
  getDisplayedRowCount(): number { return this.state.rowModel.getRowCount(); }

  exportDataAsCsv(params: any = {}): string {
    return this.state.exportService.exportCsv(this.exportColumns(params), this.exportNodes(params), this, params);
  }
  exportDataAsExcel(params: any = {}): void {
    this.state.exportService.exportExcel(this.exportColumns(params), this.exportNodes(params), this, params);
  }
  /** Uncompressed .xlsx Blob without downloading (AG getDataAsExcel). */
  getDataAsExcel(params: any = {}): Blob {
    return this.state.exportService.getDataAsExcel(this.exportColumns(params), this.exportNodes(params), this, params);
  }
  /** Worksheet data to combine via get/exportMultipleSheetsAsExcel (AG getSheetDataForExcel). */
  getSheetDataForExcel(params: any = {}): string {
    return this.state.exportService.getSheetDataForExcel(this.exportColumns(params), this.exportNodes(params), this, params);
  }
  getMultipleSheetsAsExcel(params: ExcelMultipleSheetParams): Blob | undefined {
    return this.state.exportService.getMultipleSheetsAsExcel(params);
  }
  exportMultipleSheetsAsExcel(params: ExcelMultipleSheetParams): void {
    this.state.exportService.exportMultipleSheetsAsExcel(params);
  }
  /** CSV string without triggering a download (used for SPSS export pipe). */
  getDataAsCsv(params: any = {}): string {
    return this.state.exportService.buildCsvString(this.exportColumns(params), this.exportNodes(params), this, params);
  }

  // ---- row / cell access ----
  getDisplayedRowAtIndex(index: number): RowNode | undefined { return this.state.rowModel.getRow(index); }
  getFirstDisplayedRow(): number { return this.state.view?.rowWindow?.firstRow ?? 0; }
  getLastDisplayedRow(): number { return this.state.view?.rowWindow?.lastRow ?? 0; }
  /** AG v35 getCellValue({ rowNode, colKey }) → value for a cell. */
  getCellValue(params: { rowNode: RowNode; colKey: string | any }): any {
    const node = params?.rowNode;
    const colId = typeof params?.colKey === 'string' ? params.colKey : params?.colKey?.colId ?? params?.colKey?.getColId?.();
    const col = this.state.columns.getColumn(colId) || this.state.columns.columns.find(c => c.colDef.field === colId);
    return node && col ? this.state.values.getValue(col, node) : undefined;
  }

  // ---- navigation (browser-only, delegate to the view) ----
  ensureColumnVisible(colKey: string | any): void {
    const colId = typeof colKey === 'string' ? colKey : colKey?.colId ?? colKey?.getColId?.();
    this.state.view?.ensureColumnVisible(colId);
  }
  ensureIndexVisible(index: number): void { this.state.view?.ensureIndexVisible(index); }
  setFocusedCell(rowIndex: number, colKey: string | any): void {
    const colId = typeof colKey === 'string' ? colKey : colKey?.colId ?? colKey?.getColId?.();
    this.state.view?.setFocusedCell(rowIndex, colId);
  }
  /** AG-compatible: the keyboard-focused cell, or null when nothing is focused. */
  getFocusedCell(): { rowIndex: number; column: any } | null {
    const f = this.state.view?.focusedCell;
    if (!f) return null;
    return { rowIndex: f.rowIndex, column: this.state.columns.getColumn(f.colId) };
  }
  /** Export what the user sees: pivot/grouped grids export the auto-group + result columns. */
  private exportColumns(_params: any) {
    return this.state.columns.getDisplayedColumnsForExport() ?? this.state.columns.columns;
  }
  private exportNodes(params: any): RowNode[] {
    if (params.onlySelected) return this.getSelectedNodes();
    return this.state.rowModel.getNodesForExport();
  }

  // ---- transactions ----
  // applyTransaction({update}) mutates existing nodes' data in place (node identity is kept), so
  // the grid must force a cell refresh — bumping renderTick — for OnPush cells to re-render.
  applyTransaction(tx: any): void { this.state.rowModel.applyTransaction(tx); this.state.view?.refreshCells?.(); this.state.emit(); }
  refreshCells(_params?: any): void { this.state.view?.refreshCells?.(); this.state.emit(); }
  redrawRows(_params?: any): void { this.state.view?.refreshCells?.(); this.state.emit(); }

  // ---- editing ----
  startEditingCell(params: any): void { this.state.view?.startEditingCell(params); }
  stopEditing(cancel?: boolean): void { this.state.view?.stopEditing(cancel); }
  getEditingCells(): any[] { return this.state.view?.getEditingCells() ?? []; }

  // ---- sidebar tool panels ----
  /**
   * AG-compatible: open a sidebar tool panel by id ('columns' | 'filters'). BlockSurvey's
   * contact-list opens the columns/filters panel from a dropdown via api.openToolPanel(...).
   * Sets the component's openToolPanel state (the sidebar reads it) and re-renders.
   */
  openToolPanel(panelId: string): void {
    const view = this.state.view;
    if (view) { view.openToolPanel = panelId; }
    this.state.emit();
  }
  /** AG-compatible pair to openToolPanel — collapse whichever tool panel is open. */
  closeToolPanel(): void {
    const view = this.state.view;
    if (view) { view.openToolPanel = null; }
    this.state.emit();
  }
  /** AG-compatible: id of the currently open tool panel, or null if none. */
  getOpenedToolPanel(): string | null {
    return this.state.view ? (this.state.view.openToolPanel ?? null) : null;
  }

  // ---- overlays / pagination ----
  showLoadingOverlay(): void { (this.state as any).overlayVisible = true; this.state.emit(); }
  showNoRowsOverlay(): void { this.state.emit(); }
  hideOverlay(): void { (this.state as any).overlayVisible = false; this.state.emit(); }
  // AG-compatible pagination API. Page numbers are zero-based, as in AG Grid.
  paginationIsLastPageFound(): boolean { return true; }   // client-side: the row count is always known
  paginationGetPageSize(): number { return this.state.view?.pageSize ?? 100; }
  paginationGetCurrentPage(): number { return this.state.view?.currentPage ?? 0; }
  paginationGetTotalPages(): number { return this.state.view?.totalPages ?? 0; }
  paginationGetRowCount(): number { return this.state.rowModel.getRowCount(); }
  paginationGoToPage(page: number): void { this.state.view?.paginationGoToPage(page); }
  paginationGoToNextPage(): void { this.paginationGoToPage(this.paginationGetCurrentPage() + 1); }
  paginationGoToPreviousPage(): void { this.paginationGoToPage(this.paginationGetCurrentPage() - 1); }
  paginationGoToFirstPage(): void { this.paginationGoToPage(0); }
  paginationGoToLastPage(): void { this.paginationGoToPage(this.paginationGetTotalPages() - 1); }
  /** AG ≤v30 name; v31+ uses setGridOption('paginationPageSize', n), which also works here. */
  paginationSetPageSize(size: number): void { this.state.view?.setPaginationPageSize(size); }

  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; }
}
