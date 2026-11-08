import {
  AfterViewInit, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef,
  EventEmitter, Inject, Input, NgZone, OnChanges, OnDestroy, OnInit, Output,
  PLATFORM_ID, SimpleChanges, ViewChild,
} from '@angular/core';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { BsCellComponent } from './engine/bs-cell.component';
import { GridApi } from './api/grid-api';
import {
  CellEvent, CellValueChangedEvent, ColDef, ColumnEvent, FilterChangedEvent,
  FirstDataRenderedEvent, GridOptions, GridReadyEvent, RowEvent, SelectionChangedEvent,
  SideBarDef, StatusBarDef,
} from './api/public-types';
import { AUTO_GROUP_COL_ID, ColumnService } from './core/column.service';
import { ExportService } from './core/export.service';
import { ColumnFilterModel, FilterService } from './core/filter/filter.service';
import { GridStateService } from './core/grid-state.service';
import { CellRange } from './core/models/cell-range.model';
import { computeRangeAggregation, RangeAggregation } from './core/range-aggregation';
import type { PaginationChangedEvent } from './api/public-types';
import { AutoScrollService } from './core/auto-scroll.service';
import { Column } from './core/models/column.model';
import { RowNode } from './core/models/row-node.model';
import { RangeSelectionService } from './core/range-selection.service';
import { SelectionService } from './core/selection.service';
import { SortService } from './core/sort.service';
import { ValueService } from './core/value.service';
import { ColWindow, computeColWindowFromLefts, computeRowWindow, DEFAULT_ROW_BUFFER, RowWindow } from './engine/viewport-math';

/**
 * <bs-grid> — the drop-in facade replacing <ag-grid-angular>. Exposes the AG-shaped
 * @Input/@Output surface BlockSurvey uses (docs/bs-grid/SPEC.md A.2) and hands a GridApi
 * to (gridReady). Per-instance services are provided here (not root) so multiple grids on
 * one screen are isolated. SSR-safe: no browser API touched outside isPlatformBrowser.
 *
 * Rendering (Phase 2): a single scroll viewport holds a canvas sized to the full content;
 * the header is a sticky-top flex row and pinned cells are sticky-left/right (pure CSS, no
 * manual scroll-sync). Only the visible row window (+buffer) is rendered, each row
 * absolutely positioned by its rowTop. Uniform row height for now; variable/autoHeight and
 * center-column virtualization are layered on in later phases behind this same markup.
 */
@Component({
  selector: 'bs-grid',
  imports: [CommonModule, FormsModule, BsCellComponent],
  templateUrl: './bs-grid.component.html',
  styleUrls: ['./bs-grid.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    GridStateService, ColumnService, ValueService, SortService, FilterService,
    SelectionService, RangeSelectionService, ExportService,
  ],
})
export class BsGridComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  // ---- data / columns ----
  @Input() rowData: any[] | null = null;
  @Input() columnDefs: ColDef[] | null = null;
  @Input() defaultColDef: ColDef | null = null;
  @Input() getRowId?: (params: { data: any }) => string;

  // ---- selection / editing ----
  @Input() rowSelection: 'single' | 'multiple' | any = null;
  @Input() suppressRowClickSelection = false;
  @Input() isRowSelectable?: (node: any) => boolean;
  @Input() singleClickEdit = false;
  @Input() stopEditingWhenCellsLoseFocus = false;
  /** AG v31+: after Enter commits an edit, move focus down one cell (default: focus stays). */
  @Input() enterNavigatesVerticallyAfterEdit = false;

  // ---- layout / chrome ----
  @Input() rowHeight?: number;
  @Input() headerHeight?: number;
  @Input() sideBar: SideBarDef | string | string[] | boolean | null = null;
  @Input() statusBar: StatusBarDef | null = null;
  @Input() pagination = false;
  @Input() paginationPageSize?: number;
  /** AG: size each page to exactly fill the grid's height (overrides paginationPageSize). */
  @Input() paginationAutoPageSize = false;
  /** AG v31+: page-size dropdown in the panel. true = [20, 50, 100], an array = those sizes, false = hidden. */
  @Input() paginationPageSizeSelector: boolean | number[] = true;
  /** AG: hide the built-in panel and drive pages yourself through the GridApi. */
  @Input() suppressPaginationPanel = false;
  @Input() popupParent: any = null;
  @Input() overlayLoadingTemplate?: string;
  @Input() valueCache = false;

  // ---- passthrough hooks (used later phases) ----
  @Input() enableCharts = false;
  @Input() enableRangeSelection = false;
  @Input() processCellForClipboard?: (params: any) => any;
  /** AG-compatible: transform each pasted string before it reaches the column's valueParser. */
  @Input() processCellFromClipboard?: (params: any) => any;
  @Input() getContextMenuItems?: (params: any) => any[];
  @Input() excelStyles?: any[];
  // Accepted for AG drop-in parity (column-menu icon is always visible in BsGrid, so no-op).
  @Input() suppressMenuHide: any = false;
  // Accepted for AG drop-in parity: some analytics grids pass a [summary] payload used
  // elsewhere; BsGrid stores it verbatim without rendering it.
  @Input() summary: any = null;

  @Input() gridOptions: GridOptions | null = null;

  // ---- outputs (AG-shaped) ----
  @Output() gridReady = new EventEmitter<GridReadyEvent>();
  @Output() firstDataRendered = new EventEmitter<FirstDataRenderedEvent>();
  @Output() selectionChanged = new EventEmitter<SelectionChangedEvent>();
  @Output() rowSelected = new EventEmitter<RowEvent>();
  @Output() rowClicked = new EventEmitter<RowEvent>();
  @Output() rowDoubleClicked = new EventEmitter<RowEvent>();
  @Output() cellClicked = new EventEmitter<CellEvent>();
  @Output() cellDoubleClicked = new EventEmitter<CellEvent>();
  @Output() cellValueChanged = new EventEmitter<CellValueChangedEvent>();
  @Output() cellEditingStarted = new EventEmitter<CellEvent>();
  @Output() cellContextMenu = new EventEmitter<CellEvent>();
  @Output() filterChanged = new EventEmitter<FilterChangedEvent>();
  @Output() columnPinned = new EventEmitter<ColumnEvent>();
  @Output() columnMoved = new EventEmitter<ColumnEvent>();
  @Output() columnResized = new EventEmitter<ColumnEvent>();
  @Output() columnVisible = new EventEmitter<ColumnEvent>();
  @Output() sortChanged = new EventEmitter<ColumnEvent>();
  @Output() paginationChanged = new EventEmitter<PaginationChangedEvent>();

  @ViewChild('viewport') viewportRef?: ElementRef<HTMLElement>;
  // .bs-grid-root is position:relative and is the offset parent for every popup
  // (header menu, context menu, column filter). Popup coordinates below are computed
  // relative to THIS element — not the viewport — so the popup lands under its anchor
  // regardless of how the grid is nested (analytics screen, modal, scrolled container).
  @ViewChild('root') rootRef?: ElementRef<HTMLElement>;
  // The row canvas's own element — hit-testing measures its live getBoundingClientRect()
  // rather than deriving an offset from headerHeightPx, since the sticky header/floating-
  // filter/pivot-group rows each reserve real space in the canvas's normal flow before rows
  // start, and that reserved height isn't a single known constant (floating-row height is
  // content-sized). Deriving it manually drifted out of sync and mis-hit rows below the
  // cursor on every drag — see hitTestCell.
  @ViewChild('rowsLayer') rowsLayerRef?: ElementRef<HTMLElement>;

  api!: GridApi;
  readonly isBrowser: boolean;
  private sub = new Subscription();
  private firstRendered = false;
  private initialized = false;

  // virtualization state
  rowWindow: RowWindow = { firstRow: 0, lastRow: -1 };
  renderedNodes: RowNode[] = [];
  // Column virtualization (center region only — pinned regions always render): the window of
  // center columns intersecting the viewport (+overscan), a leading spacer preserving their
  // x-offsets inside the fixed-width center region, and the tier-1 pivot spans rebuilt over
  // just the rendered columns. Without this a crosstab with hundreds of generated pivot
  // columns mounts every cell of every rendered row (rows × columns DOM explosion).
  colWindow: ColWindow = { firstCol: 0, lastCol: -1 };
  renderedCenterColumns: Column[] = [];
  centerSpacerLeft = 0;
  renderedPivotSpans: { label: string; width: number }[] = [];
  // Bumped to force every rendered cell to re-read its value / re-run its renderer when the row
  // node reference is unchanged — i.e. an in-place applyTransaction({update}) or setDataValue.
  // bs-cell is OnPush and keyed by node id, so without a changing @Input it keeps stale content.
  renderTick = 0;
  private viewportHeight = 0;
  private viewportWidth = 0;
  vScrollbarWidth = 0;
  private hscrollEl?: HTMLElement;
  private hscrollHandler?: () => void;
  private rafHandle: any = null;
  private resizeObserver: any = null;
  private scrollHandler?: () => void;

  // click disambiguation
  private clickTimer: any = null;

  // Current / active row: the single row the user last clicked. This is a focus cue (a brand
  // accent bar) — SEPARATE from checkbox selection (a fill). It acknowledges every plain row
  // click even when suppressRowClickSelection is on, and never changes selection or events.
  // Tracked by node id so it survives virtualization/re-render (trackRow also keys on n.id).
  @Input() highlightRowOnClick = true;
  /** AG processUnpinnedColumns: choose which columns get unpinned when the pinned sections no
   *  longer fit the viewport. Return [] to keep everything pinned. */
  @Input() processUnpinnedColumns?: (params: { columns: Column[]; viewportWidth: number; api: GridApi }) => Column[];   // set false to opt a grid out of the active-row cue
  activeRowId: string | null = null;

  constructor(
    public state: GridStateService,
    public cols: ColumnService,
    private cdr: ChangeDetectorRef,
    private zone: NgZone,
    @Inject(PLATFORM_ID) platformId: Object,
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  ngOnInit(): void {
    this.api = new GridApi(this.state);
    this.state.api = this.api;
    this.state.view = this;
    this.state.init(this.buildOptions());
    this.initialized = true;
    this.initSideBar();

    this.sub.add(this.state.changed$.subscribe(() => {
      // data/column/group/filter/sort changes warrant a relayout (scroll does not fire this)
      if (this.isBrowser && this.viewportRef) {
        this.cols.layout(this.viewportRef.nativeElement.clientWidth || 0);
        this.keepPinnedColumnsNarrowerThanViewport();   // a state change may have pinned columns
      }
      this.invalidateAggregation();
      this.recomputeWindow();
      this.cdr.markForCheck();
    }));

    Promise.resolve().then(() => {
      this.gridReady.emit({ api: this.api, type: 'gridReady' });
      this.maybeFirstDataRendered();
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.initialized) return;
    if (changes['columnDefs'] && this.columnDefs) this.state.setColumnDefs(this.columnDefs);
    const pagingKeys = ['pagination', 'paginationPageSize', 'paginationAutoPageSize', 'suppressPaginationPanel'] as const;
    if (pagingKeys.some(k => changes[k])) {
      for (const k of pagingKeys) if (changes[k]) (this.state.options as any)[k] = (this as any)[k];
      // A new [paginationPageSize] from the host replaces any size picked in the panel.
      if (changes['paginationPageSize']) this.pageSizeOverride = null;
      this.state.emit();
    }
    if (changes['rowData'] && this.rowData) {
      this.state.setRowData(this.rowData);
      this.maybeFirstDataRendered();
    }
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser) return;
    const el = this.viewportRef?.nativeElement;
    if (!el) return;
    // Attach scroll + resize wiring OUTSIDE Angular; only re-enter the zone when the
    // rendered window actually changes (keeps scrolling cheap).
    this.zone.runOutsideAngular(() => {
      this.scrollHandler = () => { this.syncHScrollFromViewport(); this.onScroll(); };
      el.addEventListener('scroll', this.scrollHandler, { passive: true });
      if (typeof (window as any).ResizeObserver !== 'undefined') {
        this.resizeObserver = new (window as any).ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(el);
      }
      // Keyboard-focus wiring, outside the zone so neither event triggers change detection
      // mid-click (see the template comment on .bs-grid-root).
      const root = this.rootRef?.nativeElement;
      if (root) {
        this.rootPointerDownHandler = () => { this.lastPointerDownTs = Date.now(); };
        this.rootFocusHandler = (fe: FocusEvent) => this.onRootFocus(fe);
        root.addEventListener('pointerdown', this.rootPointerDownHandler, { passive: true });
        root.addEventListener('focus', this.rootFocusHandler);
      }
    });
    this.onResize();
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    if (this.isBrowser) {
      const el = this.viewportRef?.nativeElement;
      if (el && this.scrollHandler) el.removeEventListener('scroll', this.scrollHandler);
      if (this.hscrollEl && this.hscrollHandler) this.hscrollEl.removeEventListener('scroll', this.hscrollHandler);
      this.resizeObserver?.disconnect();
      if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
      if (this.resizeRaf != null) cancelAnimationFrame(this.resizeRaf);
      // Remove any pointer listeners still attached mid resize/drag (destroy during interaction),
      // and drop popup outside-click handlers, so nothing fires on a torn-down component.
      if (this.resizeMove) window.removeEventListener('pointermove', this.resizeMove);
      if (this.resizeUp) window.removeEventListener('pointerup', this.resizeUp);
      if (this.dragMove) window.removeEventListener('pointermove', this.dragMove);
      if (this.dragUp) window.removeEventListener('pointerup', this.dragUp);
      this.teardownRangeDrag();
      const rootEl = this.rootRef?.nativeElement;
      if (rootEl && this.rootPointerDownHandler) rootEl.removeEventListener('pointerdown', this.rootPointerDownHandler);
      if (rootEl && this.rootFocusHandler) rootEl.removeEventListener('focus', this.rootFocusHandler);
      if (this.filterOutside) document.removeEventListener('mousedown', this.filterOutside);
      if (this.ctxOutside) document.removeEventListener('mousedown', this.ctxOutside);
      if (this.menuOutsideHandler) document.removeEventListener('mousedown', this.menuOutsideHandler);
    }
    if (this.clickTimer) clearTimeout(this.clickTimer);
    if (this.filterDebounce) clearTimeout(this.filterDebounce);
    this.api?.destroy();
  }

  private buildOptions(): GridOptions {
    const opts: GridOptions = { ...(this.gridOptions || {}) };
    opts.columnDefs = this.columnDefs || opts.columnDefs || [];
    opts.defaultColDef = this.defaultColDef || opts.defaultColDef || {};
    opts.rowData = this.rowData || opts.rowData || [];
    opts.getRowId = this.getRowId || opts.getRowId;
    opts.rowSelection = this.rowSelection ?? opts.rowSelection;
    opts.suppressRowClickSelection = this.suppressRowClickSelection ?? opts.suppressRowClickSelection;
    opts.enableRangeSelection = this.enableRangeSelection ?? opts.enableRangeSelection;
    opts.isRowSelectable = this.isRowSelectable || opts.isRowSelectable;
    opts.singleClickEdit = this.singleClickEdit ?? opts.singleClickEdit;
    opts.stopEditingWhenCellsLoseFocus = this.stopEditingWhenCellsLoseFocus ?? opts.stopEditingWhenCellsLoseFocus;
    opts['enterNavigatesVerticallyAfterEdit'] = this.enterNavigatesVerticallyAfterEdit || !!opts['enterNavigatesVerticallyAfterEdit'];
    // `|| 28` also rejects a 0 rowHeight, which would divide-by-zero in the virtualization math.
    opts.rowHeight = (this.rowHeight ?? opts.rowHeight ?? 28) || 28;
    opts.headerHeight = (this.headerHeight ?? opts.headerHeight ?? 32) || 32;
    opts.valueCache = this.valueCache ?? opts.valueCache;
    opts.popupParent = this.popupParent ?? opts.popupParent;
    opts.overlayLoadingTemplate = this.overlayLoadingTemplate ?? opts.overlayLoadingTemplate;
    opts.pagination = this.pagination || !!opts.pagination;
    opts.paginationPageSize = this.paginationPageSize ?? opts.paginationPageSize;
    opts['paginationAutoPageSize'] = this.paginationAutoPageSize || !!opts['paginationAutoPageSize'];
    opts['suppressPaginationPanel'] = this.suppressPaginationPanel || !!opts['suppressPaginationPanel'];
    opts['context'] = this.gridOptions?.['context'];
    return opts;
  }

  private maybeFirstDataRendered(): void {
    if (this.firstRendered || !this.state.rowModel) return;
    this.firstRendered = true;
    Promise.resolve().then(() => {
      this.recomputeWindow();
      this.firstDataRendered.emit({ api: this.api, type: 'firstDataRendered' });
      this.cdr.markForCheck();
    });
  }

  // ---- scroll / resize / windowing ----
  private onScroll(): void {
    if (this.rafHandle) return;
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = null;
      const beforeRows = this.rowWindow;
      const beforeCols = this.colWindow;
      this.recomputeWindow();
      if (beforeRows.firstRow !== this.rowWindow.firstRow || beforeRows.lastRow !== this.rowWindow.lastRow
        || beforeCols.firstCol !== this.colWindow.firstCol || beforeCols.lastCol !== this.colWindow.lastCol) {
        this.zone.run(() => this.cdr.markForCheck());
      }
    });
  }

  // Fake horizontal scrollbar (AG parity): the track under the center columns mirrors the
  // viewport's scrollLeft 1:1 — track width = clientWidth − pinned widths and content width
  // = centerWidth, so both scroll ranges are identical (totalWidth − clientWidth).
  get hscrollNeeded(): boolean {
    return this.isBrowser && this.totalWidth > this.viewportWidth && this.viewportWidth > 0;
  }

  @ViewChild('hscroll') set hscrollRef(ref: ElementRef<HTMLElement> | undefined) {
    const el = ref?.nativeElement;
    if (el === this.hscrollEl) return;
    if (this.hscrollEl && this.hscrollHandler) this.hscrollEl.removeEventListener('scroll', this.hscrollHandler);
    this.hscrollEl = el;
    if (!el) return;
    this.zone.runOutsideAngular(() => {
      this.hscrollHandler = () => {
        const vp = this.viewportRef?.nativeElement;
        if (vp && Math.abs(vp.scrollLeft - el.scrollLeft) >= 1) vp.scrollLeft = el.scrollLeft;
      };
      el.addEventListener('scroll', this.hscrollHandler, { passive: true });
      el.scrollLeft = this.viewportRef?.nativeElement.scrollLeft ?? 0;
    });
  }

  private syncHScrollFromViewport(): void {
    const vp = this.viewportRef?.nativeElement;
    const hs = this.hscrollEl;
    if (vp && hs && Math.abs(hs.scrollLeft - vp.scrollLeft) >= 1) hs.scrollLeft = vp.scrollLeft;
  }

  /** AG PinnedColumnService.MIN_CENTER_VIEWPORT_WIDTH: center width kept when columns are pinned. */
  private static readonly MIN_CENTER_VIEWPORT_WIDTH = 50;

  /**
   * AG PinnedColumnService.keepPinnedColumnsNarrowerThanViewport (v31+). When the pinned
   * sections leave less than 50px of center viewport (a phone, a narrow panel), unpin columns,
   * alternating right then left in display order, skipping lockPinned, until they fit.
   * Runs on viewport resize and after pinning, like AG. Columns are not re-pinned when the
   * viewport grows again (AG doesn't either); the host can restore pins from saved state.
   */
  private keepPinnedColumnsNarrowerThanViewport(): boolean {
    const el = this.viewportRef?.nativeElement;
    if (!this.isBrowser || !el) return false;
    const bodyWidth = el.clientWidth;   // excludes the vertical scrollbar
    const MIN = BsGridComponent.MIN_CENTER_VIEWPORT_WIDTH;
    if (bodyWidth <= MIN) return false;
    const total = this.cols.leftWidth + this.cols.rightWidth;
    let space = total - (bodyWidth - MIN);
    if (space < 0) return false;

    const left = [...this.cols.leftColumns];
    const right = [...this.cols.rightColumns];
    let remove: Column[] = [];
    let hasLocked = false;
    let li = 0, ri = 0;
    while (space > 0 && (li < left.length || ri < right.length)) {
      if (ri < right.length) {
        const c = right[ri++];
        if (c.colDef.lockPinned) { hasLocked = true; } else { space -= c.width; remove.push(c); }
      }
      if (space > 0 && li < left.length) {
        const c = left[li++];
        if (c.colDef.lockPinned) { hasLocked = true; } else { space -= c.width; remove.push(c); }
      }
    }
    if (!remove.length && !hasLocked) return false;
    const custom = this.processUnpinnedColumns ?? this.state.options['processUnpinnedColumns'];
    if (typeof custom === 'function') {
      remove = custom({ columns: remove, viewportWidth: bodyWidth, api: this.api }) ?? [];
    }
    remove = remove.filter(c => c && c.pinned && !c.colDef.lockPinned);
    if (!remove.length) return false;
    for (const c of remove) this.cols.setPinned(c.colId, null);
    this.cols.layout(bodyWidth);
    this.zone.run(() => this.columnPinned.emit({
      api: this.api, type: 'columnPinned', columns: remove, column: remove.length === 1 ? remove[0] : undefined,
      pinned: null, source: 'viewportSizeFeature',
    } as ColumnEvent));
    return true;
  }

  private onResize(): void {
    const el = this.viewportRef?.nativeElement;
    if (!el) return;
    this.viewportHeight = el.clientHeight;
    this.viewportWidth = el.clientWidth;
    this.vScrollbarWidth = el.offsetWidth - el.clientWidth;
    this.cols.layout(el.clientWidth);
    this.keepPinnedColumnsNarrowerThanViewport();
    this.recomputeWindow();
    this.zone.run(() => this.cdr.markForCheck());
  }

  private recomputeWindow(newPage = false): void {
    this.calculatePages();
    // With pagination the canvas holds only the current page: the window is computed in
    // page-local rows, then offset by the page's first display index.
    const first = this.pageFirstRow;
    const count = this.pageRowCount;
    const rowHeight = this.rowHeightPx;
    const scrollTop = this.viewportRef?.nativeElement.scrollTop ?? 0;
    const vh = this.viewportHeight || this.viewportRef?.nativeElement.clientHeight || 400;
    this.rowWindow = computeRowWindow(scrollTop, vh, count, rowHeight, DEFAULT_ROW_BUFFER);
    const displayed = this.state.rowModel?.getDisplayedNodes() ?? [];
    const out: RowNode[] = [];
    for (let i = this.rowWindow.firstRow; i <= this.rowWindow.lastRow; i++) {
      const n = displayed[first + i];
      if (n) { n.rowTop = i * rowHeight; n.rowHeight = rowHeight; out.push(n); }
    }
    this.emitPaginationIfChanged(newPage);
    this.renderedNodes = out;
    (this.state as any).renderedNodes = out;
    this.recomputeColWindow();
  }

  /**
   * Center-column window. The sticky-left pinned region overlays the first leftWidth px of
   * scrolled content, so the visible center range starts at scrollLeft − leftWidth in
   * center-relative coordinates. A px overscan on both sides keeps horizontal scrolling
   * smooth (mirrors the row window's buffer).
   */
  private static readonly COL_OVERSCAN_PX = 200;
  private recomputeColWindow(): void {
    const center = this.cols.centerColumns;
    const lefts = this.cols.centerLefts;   // cached prefix-sum; rebuilt only when widths change
    const el = this.viewportRef?.nativeElement;
    const scrollLeft = el?.scrollLeft ?? 0;
    const vw = this.viewportWidth || el?.clientWidth || 800;
    const over = BsGridComponent.COL_OVERSCAN_PX;
    this.colWindow = computeColWindowFromLefts(
      Math.max(0, scrollLeft - this.cols.leftWidth - over), vw + 2 * over, lefts);
    const { firstCol, lastCol } = this.colWindow;
    this.centerSpacerLeft = lefts[firstCol] ?? 0;
    this.renderedCenterColumns = lastCol >= firstCol ? center.slice(firstCol, lastCol + 1) : [];
    // Tier-1 pivot spans over the rendered columns only (a span clipped by the window edge
    // renders from the edge — its label stays readable, and offsets align with tier 2).
    if (this.showPivotGroupHeader) {
      const spans: { label: string; width: number }[] = [];
      let cur: { label: string; width: number } | null = null;
      for (const c of this.renderedCenterColumns) {
        const label = (c as any).pivotGroupLabel ?? c.headerName;
        if (cur && cur.label === label) cur.width += c.width || 0;
        else { cur = { label, width: c.width || 0 }; spans.push(cur); }
      }
      this.renderedPivotSpans = spans;
    } else {
      this.renderedPivotSpans = [];
    }
  }

  relayout(): void {
    if (!this.isBrowser) return;
    this.onResize();
  }

  // ---- view helpers (template) ----
  get rowHeightPx(): number { return this.state.options.rowHeight ?? 28; }
  get headerHeightPx(): number { return this.state.options.headerHeight ?? 32; }
  get totalRowCount(): number { return this.state.rowModel?.getRowCount() ?? 0; }
  get allRowCount(): number { return this.state.rowModel?.getAllCount() ?? 0; }
  get selectedCount(): number { return this.state.selection?.count() ?? 0; }
  get isFiltered(): boolean { return this.state.filter?.isAnyFilterPresent() ?? false; }
  get canvasHeight(): number { return this.pageRowCount * this.rowHeightPx; }

  // ---- pagination (AG PaginationProxy semantics: a page is a slice of the display list;
  // row indexes stay global, navigation is bounded to the page, and the page is clamped,
  // not reset, when data/filter/sort change the row count) ----
  currentPage = 0;
  private lastPaging: { page: number; size: number; total: number; rows: number; data: unknown } | null = null;
  private pageSizeOverride: number | null = null;   // set from the panel's page-size dropdown

  get paginationActive(): boolean { return !!this.state.options?.pagination; }
  get showPaginationPanel(): boolean { return this.paginationActive && !this.state.options['suppressPaginationPanel']; }
  get pageSize(): number {
    if (this.state.options?.['paginationAutoPageSize']) {
      const vh = this.viewportHeight || this.viewportRef?.nativeElement.clientHeight || 0;
      // AG checkPageSize: floor(bodyHeight / rowHeight). The body is the viewport minus the
      // sticky header rows above the rows layer (header + floating filters + pivot group row).
      const reserved = this.rowsLayerRef?.nativeElement.offsetTop ?? this.headerHeightPx;
      const body = vh - reserved;
      if (body > 0) return Math.max(1, Math.floor(body / this.rowHeightPx));
    }
    const size = this.pageSizeOverride ?? this.state.options?.paginationPageSize;
    return size != null && size >= 1 ? Math.floor(size) : 100;   // AG default page size
  }
  get totalPages(): number {
    const n = this.totalRowCount;
    return !this.paginationActive ? 1 : n > 0 ? Math.floor((n - 1) / this.pageSize) + 1 : 0;
  }
  get pageFirstRow(): number { return this.paginationActive ? this.currentPage * this.pageSize : 0; }
  get pageLastRow(): number {
    const last = this.totalRowCount - 1;
    return this.paginationActive ? Math.min(last, this.pageFirstRow + this.pageSize - 1) : last;
  }
  get pageRowCount(): number { return Math.max(0, this.pageLastRow - this.pageFirstRow + 1); }
  get pageSizeOptions(): number[] {
    const sel = this.paginationPageSizeSelector;
    if (sel === false || this.state.options?.['paginationAutoPageSize']) return [];
    const base = Array.isArray(sel) ? sel : [20, 50, 100];
    // AG: the current page size is always offered, even when it isn't in the list.
    return [...new Set([...base, this.pageSize])].filter(n => n >= 1).sort((a, b) => a - b);
  }

  /** AG calculatePages: clamp the current page into range after any model change. */
  private calculatePages(): void {
    if (!this.paginationActive) { this.currentPage = 0; return; }
    const total = this.totalPages;
    if (this.currentPage >= total) this.currentPage = total - 1;
    if (!(this.currentPage >= 0)) this.currentPage = 0;
  }

  /** Emit paginationChanged when page, size, page count or row count moved (AG fires it on
   *  every model update; firing only on a real change keeps scroll ticks quiet). */
  private emitPaginationIfChanged(newPage: boolean): void {
    if (!this.paginationActive) { this.lastPaging = null; return; }
    const now = { page: this.currentPage, size: this.pageSize, total: this.totalPages, rows: this.totalRowCount, data: this.state.options.rowData };
    const prev = this.lastPaging;
    if (prev && prev.page === now.page && prev.size === now.size && prev.total === now.total && prev.rows === now.rows && prev.data === now.data) return;
    this.lastPaging = now;
    const ev: PaginationChangedEvent = {
      api: this.api, type: 'paginationChanged', animate: false,
      newData: !!prev && prev.data !== now.data, newPage, newPageSize: !!prev && prev.size !== now.size,
      keepRenderedRows: !newPage,
    };
    this.zone.run(() => this.paginationChanged.emit(ev));
  }

  paginationGoToPage(page: number): void {
    if (!this.paginationActive) return;
    const target = Math.max(0, Math.min(this.totalPages - 1, Math.floor(page)));
    if (target === this.currentPage) return;
    this.currentPage = target;
    // AG: a new page scrolls the body back to the top.
    const el = this.viewportRef?.nativeElement;
    if (el) el.scrollTop = 0;
    this.recomputeWindow(true);
    this.zone.run(() => this.cdr.markForCheck());
  }

  setPaginationPageSize(size: number | null): void {
    // AG PaginationProxy.onPaginationPageSizeChanged: keep the current page index, let
    // calculatePages() clamp it to the new page count, and keep the scroll position.
    this.pageSizeOverride = size != null && size >= 1 ? Math.floor(size) : null;
    if (size != null) (this.state.options as any).paginationPageSize = this.pageSizeOverride;
    this.recomputeWindow();
    this.zone.run(() => this.cdr.markForCheck());
  }

  onPageSizeSelect(ev: Event): void {
    this.setPaginationPageSize(Number((ev.target as HTMLSelectElement).value));
  }
  get totalWidth(): number { return this.cols.leftWidth + this.cols.centerWidth + this.cols.rightWidth; }
  get leftColumns(): Column[] { return this.cols.leftColumns; }
  get centerColumns(): Column[] { return this.cols.centerColumns; }
  get rightColumns(): Column[] { return this.cols.rightColumns; }
  get allVisibleColumns(): Column[] { return this.cols.orderedVisibleColumns; }
  get overlayVisible(): boolean { return !!(this.state as any).overlayVisible; }

  displayValue(col: Column, node: RowNode): any {
    return this.state.values.getDisplayValue(col, node);
  }

  // ---- pivot two-tier header (AG parity: pivot value group over its measure columns) ----
  /** Tier-1 shown only when 2+ aggregations are checked; one measure keeps a single row. */
  get showPivotGroupHeader(): boolean {
    return this.cols.pivotMode && this.cols.generatedPivotColumns.length > 0
      && this.cols.getValueColumns().length > 1;
  }

  /** Sticky-top offset of the main header row (below the pivot group tier when shown). */
  get headerOffsetPx(): number { return this.showPivotGroupHeader ? this.headerHeightPx : 0; }

  // (tier-1 pivot spans are computed over the rendered column window — see recomputeColWindow)

  /** With the tier-1 row shown, a generated column's own header is just its measure name. */
  headerLabel(col: Column): string {
    const sub = (col as any).pivotSubLabel;
    return this.showPivotGroupHeader && sub ? sub : col.headerName;
  }

  // ---- cell styling (cellStyle / cellClass / cellClassRules) ----
  cellClasses(col: Column, node: RowNode): string[] {
    const def = col.colDef;
    const out: string[] = [];
    const push = (v: any) => { if (Array.isArray(v)) out.push(...v); else if (v) out.push(v); };
    if (def.cellClass) {
      push(typeof def.cellClass === 'function' ? def.cellClass(this.cellParams(col, node)) : def.cellClass);
    }
    if (def.cellClassRules) {
      const p = this.cellParams(col, node);
      for (const cls of Object.keys(def.cellClassRules)) {
        const test = def.cellClassRules[cls];
        // function form only (string-expression form intentionally unsupported — no eval)
        if (typeof test === 'function' && test(p)) out.push(cls);
      }
    }
    return out;
  }

  cellStyles(col: Column, node: RowNode): { [k: string]: any } | null {
    const cs = col.colDef.cellStyle;
    if (!cs) return null;
    return typeof cs === 'function' ? cs(this.cellParams(col, node)) : cs;
  }

  private cellParams(col: Column, node: RowNode): any {
    const p = this.state.values.buildBaseParams(node, col);
    p.value = this.state.values.getValue(col, node);
    return p;
  }

  trackCol = (_: number, c: Column) => c.colId;
  trackRow = (_: number, n: RowNode) => n.id;

  // ---- sorting ----
  onHeaderClick(col: Column, ev: MouseEvent): void {
    if (this.draggingCol || this.resizingCol) return;   // ignore clicks that ended a drag/resize
    this.setHeaderFocus(col.colId);                     // AG focuses the clicked header cell
    if (!col.isSortable()) return;
    this.sortCycle(col, ev.shiftKey || ev.ctrlKey || ev.metaKey);
  }

  private sortCycle(col: Column, multi: boolean): void {
    this.state.rangeSelection.clear();   // sort reorders rows — a range's row indices go stale
    this.state.sort.cycleSort(col, this.cols.columns, multi);
    this.state.rowModel.refresh();
    this.recomputeWindow();
    this.cdr.markForCheck();
    this.sortChanged.emit({ api: this.api, type: 'sortChanged', column: col });
  }

  sortArrow(col: Column): string { return col.sort === 'asc' ? '▲' : col.sort === 'desc' ? '▼' : ''; }
  sortOrdinal(col: Column): string {
    const active = this.cols.columns.filter(c => c.sort);
    return active.length > 1 && col.sortIndex != null ? String(col.sortIndex + 1) : '';
  }

  // ---- resize ----
  resizingCol: Column | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  private resizeMove?: (e: PointerEvent) => void;
  private resizeUp?: (e: PointerEvent) => void;
  private resizeRaf: any = null;
  private resizePendingX = 0;

  onResizeStart(col: Column, ev: PointerEvent): void {
    if (!this.isBrowser || !col.isResizable()) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.resizingCol = col;
    this.resizeStartX = ev.clientX;
    this.resizeStartWidth = col.width;
    this.resizePendingX = ev.clientX;
    this.zone.runOutsideAngular(() => {
      this.resizeMove = (e: PointerEvent) => {
        // Coalesce pointermove bursts (high-Hz mice/trackpads fire faster than a frame) into one
        // layout per animation frame — layout() is O(columns), so running it per event janks a
        // wide grid (audit P2).
        this.resizePendingX = e.clientX;
        if (this.resizeRaf != null) return;
        this.resizeRaf = requestAnimationFrame(() => {
          this.resizeRaf = null;
          this.applyResize(col);
        });
      };
      this.resizeUp = () => {
        window.removeEventListener('pointermove', this.resizeMove!);
        window.removeEventListener('pointerup', this.resizeUp!);
        if (this.resizeRaf != null) { cancelAnimationFrame(this.resizeRaf); this.resizeRaf = null; }
        this.applyResize(col);   // flush the final pointer position
        const col2 = this.resizingCol;
        // defer clearing so the ensuing header click is suppressed
        setTimeout(() => (this.resizingCol = null), 0);
        this.zone.run(() => this.columnResized.emit({ api: this.api, type: 'columnResized', column: col2! }));
      };
      window.addEventListener('pointermove', this.resizeMove);
      window.addEventListener('pointerup', this.resizeUp);
    });
  }

  /** Apply the current drag width to `col` and relayout. Runs outside Angular (rAF/pointerup). */
  private applyResize(col: Column): void {
    let w = this.resizeStartWidth + (this.resizePendingX - this.resizeStartX);
    // AG limitResize: a pinned column may only grow while the pinned sections leave
    // MIN_CENTER_VIEWPORT_WIDTH of center viewport. Shrinking is never limited.
    if (col.pinned) {
      const vw = this.viewportRef?.nativeElement.clientWidth || 0;
      const room = vw - BsGridComponent.MIN_CENTER_VIEWPORT_WIDTH - this.cols.leftWidth - this.cols.rightWidth + col.width;
      if (w > col.width && w > room) w = Math.max(col.width, room);
    }
    // Manually resizing a flex column pins it to a fixed width (AG parity). Without this,
    // layout() re-derives the width from the flex algorithm and discards the drag — so flex
    // columns (e.g. the contact list's flex:1 columns) appeared un-resizable.
    col.flex = null;
    col.width = clampWidth(w, col.minWidth, col.maxWidth);
    this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
    this.recomputeColWindow();   // widths shift the rendered-column offsets
    this.zone.run(() => this.cdr.markForCheck());
  }

  onResizeDblClick(col: Column, ev: MouseEvent): void {
    ev.stopPropagation();
    this.autoSizeColumn(col);
  }

  // ---- autosize (browser-only measurement) ----
  autoSizeColumn(col: Column): void {
    if (!this.isBrowser) return;
    const width = this.measureColumnWidth(col);
    if (width > 0) {
      col.flex = null;   // autosize pins to a fixed width (AG parity) — see onResizeStart
      col.width = clampWidth(width, col.minWidth, col.maxWidth);
      this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
      this.recomputeColWindow();
      this.cdr.markForCheck();
      this.columnResized.emit({ api: this.api, type: 'columnResized', column: col });
    }
  }

  autoSizeAllColumns(): void {
    if (!this.isBrowser) return;
    const resized: Column[] = [];
    for (const col of this.allVisibleColumns) {
      const w = this.measureColumnWidth(col);
      if (w > 0) { col.flex = null; col.width = clampWidth(w, col.minWidth, col.maxWidth); resized.push(col); }
    }
    this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
    this.recomputeColWindow();
    this.cdr.markForCheck();
    // AG parity: one columnResized for the batch, so hosts persisting column state see it.
    if (resized.length) this.columnResized.emit({ api: this.api, type: 'columnResized', columns: resized });
  }

  private measureCanvas?: any;
  private measureColumnWidth(col: Column): number {
    // measure header + currently-rendered cell text via a canvas 2d context (fast, no reflow)
    const ctx = (this.measureCanvas ??= document.createElement('canvas')).getContext('2d');
    if (!ctx) return 0;
    // Measure in the font cells actually render with (the theme's --bs-grid-font, Inter by
    // default). A hardcoded system font under-measures Inter and clips autosized text.
    const root = this.rootRef?.nativeElement;
    const rootStyle = root ? getComputedStyle(root) : null;
    ctx.font = rootStyle?.font || `${rootStyle?.fontSize || '13px'} ${rootStyle?.fontFamily || 'sans-serif'}`;
    const CHECKBOX = 16 + 6;   // .bs-grid-checkbox width + .bs-grid-cell gap
    let max = ctx.measureText(col.headerName).width + 28   // header + menu button allowance
      + (this.showsHeaderCheckbox(col) ? CHECKBOX : 0);
    const cellCheckbox = this.showsCheckbox(col) ? CHECKBOX : 0;
    for (const node of this.renderedNodes) {
      const text = String(this.displayValue(col, node) ?? '');
      max = Math.max(max, ctx.measureText(text).width + 18 + cellCheckbox); // + cell padding
    }
    return Math.ceil(max);
  }

  // ---- reorder (drag header) ----
  draggingCol: Column | null = null;
  dragIndicatorX: number | null = null;
  private dragStartX = 0;
  private dragMove?: (e: PointerEvent) => void;
  private dragUp?: (e: PointerEvent) => void;

  onHeaderPointerDown(col: Column, ev: PointerEvent): void {
    if (!this.isBrowser || !col.isMovable() || ev.button !== 0) return;
    const startX = ev.clientX;
    let started = false;
    this.dragStartX = startX;
    this.zone.runOutsideAngular(() => {
      this.dragMove = (e: PointerEvent) => {
        if (!started && Math.abs(e.clientX - startX) < 5) return;   // threshold
        started = true;
        this.draggingCol = col;
        this.dragIndicatorX = e.clientX - this.viewportLeft();
        this.zone.run(() => this.cdr.markForCheck());
      };
      this.dragUp = (e: PointerEvent) => {
        window.removeEventListener('pointermove', this.dragMove!);
        window.removeEventListener('pointerup', this.dragUp!);
        if (started) {
          const targetIndex = this.dropIndex(e.clientX);
          if (targetIndex != null) {
            this.cols.moveColumn(col.colId, targetIndex);
            this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
            this.recomputeColWindow();   // column order changed → rendered window shifts
            this.zone.run(() => this.columnMoved.emit({ api: this.api, type: 'columnMoved', column: col }));
          }
        }
        this.dragIndicatorX = null;
        // defer clearing so the click after drop is suppressed
        setTimeout(() => (this.draggingCol = null), 0);
        this.zone.run(() => this.cdr.markForCheck());
      };
      window.addEventListener('pointermove', this.dragMove);
      window.addEventListener('pointerup', this.dragUp);
    });
  }

  private viewportLeft(): number {
    return this.viewportRef?.nativeElement.getBoundingClientRect().left ?? 0;
  }

  /** column index (in the global columns array) to insert the dragged column before. */
  private dropIndex(clientX: number): number | null {
    const el = this.viewportRef?.nativeElement;
    if (!el) return null;
    const x = clientX - el.getBoundingClientRect().left + el.scrollLeft;
    // walk center columns; find the boundary the pointer is nearest
    let acc = this.cols.leftWidth;
    for (const c of this.cols.centerColumns) {
      if (x < acc + c.width / 2) return this.cols.columns.indexOf(c);
      acc += c.width;
    }
    // dropped past the last center column
    const last = this.cols.centerColumns[this.cols.centerColumns.length - 1];
    return last ? this.cols.columns.indexOf(last) + 1 : null;
  }

  // ---- side bar (Phase 8) ----
  openToolPanel: string | null = null;
  columnSearch = '';
  private sideBarInitialized = false;

  // Memoized: a fresh array each CD would make the *ngFor recreate the tab buttons whenever
  // any event ticks change detection — killing a keyboard activation in flight (Enter/Space's
  // default click aborts if the button is detached between keydown and the click action).
  private sideBarTabsCache: { id: string; label: string }[] = [];
  private sideBarTabsFor: any = null;
  get sideBarTabs(): { id: string; label: string }[] {
    const sb = this.sideBar;
    if (sb === this.sideBarTabsFor) return this.sideBarTabsCache;
    this.sideBarTabsFor = sb;
    this.sideBarTabsCache =
      !sb ? []
        : sb === true ? [{ id: 'columns', label: 'Columns' }, { id: 'filters', label: 'Filters' }]
          : typeof sb === 'string' ? [{ id: sb, label: cap(sb) }]
            : Array.isArray(sb) ? sb.map(s => ({ id: s, label: cap(s) }))
              : ((sb as any).toolPanels || []).map((p: any) => ({ id: p.id, label: p.labelDefault || cap(p.id) }));
    return this.sideBarTabsCache;
  }

  private initSideBar(): void {
    if (this.sideBarInitialized) return;
    this.sideBarInitialized = true;
    const sb = this.sideBar as any;
    if (sb && typeof sb === 'object' && !Array.isArray(sb) && sb.defaultToolPanel) {
      this.openToolPanel = sb.defaultToolPanel;
    }
  }

  toggleToolPanel(id: string): void {
    const opening = this.openToolPanel !== id;
    this.openToolPanel = opening ? id : null;
    this.cdr.markForCheck();
    // Panel sits before the tab strip in DOM, so forward-Tab from the tab button would skip
    // it — move focus into the fresh panel's search box instead (keyboard + mouse alike).
    if (opening && this.isBrowser) {
      setTimeout(() => this.rootRef?.nativeElement
        .querySelector<HTMLElement>('.bs-grid-sidebar-panel .bs-grid-tool-search')?.focus());
    }
  }

  get columnsForPanel(): Column[] {
    const q = this.columnSearch.toLowerCase().trim();
    return this.cols.columns.filter(c =>
      !c.colDef.suppressColumnsToolPanel && (!q || c.headerName.toLowerCase().includes(q)));
  }

  toggleColumnVisible(col: Column): void {
    col.hide = !col.hide;
    this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
    this.recomputeWindow();
    this.cdr.markForCheck();
    // Parity with AG's (columnVisible): hosts persist visibility state on this event.
    this.columnVisible.emit({ api: this.api, type: 'columnVisible', column: col });
  }

  // ---- Filters tool panel (advanced per-column operator filters) ----
  // Collapsible list; each column gets an operator dropdown + value input(s). The operator
  // choice is remembered even while the value is empty (so "pick Starts with, then type"
  // works). Text/number/date operators map to the same models the predicate engine already
  // understands; no new filter math needed.
  expandedToolFilters = new Set<string>();
  private toolOpMemory: Record<string, string> = {};

  private columnFilterable(col: Column): boolean {
    if (col.colDef.filter === false || col.colDef.suppressFiltersToolPanel) return false;
    return col.colDef.filter != null || !!this.state.options.defaultColDef?.filter;
  }

  get filterableColumnsForPanel(): Column[] {
    return this.columnsForPanel.filter(c => this.columnFilterable(c));
  }

  isToolFilterOpen(col: Column): boolean { return this.expandedToolFilters.has(col.colId); }

  toggleToolFilter(col: Column): void {
    if (this.expandedToolFilters.has(col.colId)) this.expandedToolFilters.delete(col.colId);
    else this.expandedToolFilters.add(col.colId);
    this.cdr.markForCheck();
  }

  /** which operator family the Filters panel should show for this column. */
  toolFilterKind(col: Column): 'text' | 'number' | 'date' {
    const f = col.colDef.filter;
    if (f === 'agNumberColumnFilter') return 'number';
    if (f === 'agDateColumnFilter') return 'date';
    return 'text';   // text / set / multi / default all use text operators here
  }

  toolInputType(col: Column): 'text' | 'number' | 'date' {
    const k = this.toolFilterKind(col);
    return k === 'number' ? 'number' : k === 'date' ? 'date' : 'text';
  }

  // Stable operator lists — returning the SAME array reference per kind avoids an NG0103
  // infinite change-detection loop (a fresh array each CD makes <select [ngModel]> option
  // reconciliation re-trigger CD forever).
  toolOps(col: Column): { value: string; label: string }[] {
    switch (this.toolFilterKind(col)) {
      case 'number': return TOOL_NUMBER_OPS;
      case 'date': return TOOL_DATE_OPS;
      default: return TOOL_TEXT_OPS;
    }
  }

  /** the model that drives this column's Filters-panel inputs (the text sub, if multi). */
  private toolActiveModel(col: Column): ColumnFilterModel | undefined {
    const m = this.state.filter.getColumnModel(col.colId);
    if (m?.filterType === 'multi') {
      return (m.filters || []).find(s => s.filterType === 'text' || s.filterType === 'number' || s.filterType === 'date');
    }
    return m;
  }

  toolOp(col: Column): string {
    if (this.toolOpMemory[col.colId]) return this.toolOpMemory[col.colId];
    const m = this.toolActiveModel(col);
    if (m?.type) return m.type;
    const k = this.toolFilterKind(col);
    return k === 'text' ? 'contains' : 'equals';
  }

  toolValue(col: Column): string {
    const m = this.toolActiveModel(col);
    if (!m) return '';
    return String(m.filter ?? m.dateFrom ?? '');
  }

  toolValueTo(col: Column): string {
    const m = this.toolActiveModel(col);
    if (!m) return '';
    return String(m.filterTo ?? m.dateTo ?? '');
  }

  toolIsRange(col: Column): boolean { return this.toolOp(col) === 'inRange'; }

  setToolOp(col: Column, op: string): void {
    this.toolOpMemory[col.colId] = op;
    this.applyToolFilter(col, op, this.toolValue(col), this.toolValueTo(col));
  }
  setToolValue(col: Column, v: string): void {
    this.applyToolFilter(col, this.toolOp(col), v, this.toolValueTo(col));
  }
  setToolValueTo(col: Column, v: string): void {
    this.applyToolFilter(col, this.toolOp(col), this.toolValue(col), v);
  }

  clearToolFilter(col: Column): void {
    delete this.toolOpMemory[col.colId];
    this.state.filter.setColumnFilter(col.colId, null);
    this.commitFilterChange();
  }

  private applyToolFilter(col: Column, op: string, value: string, valueTo: string): void {
    const kind = this.toolFilterKind(col);
    let model: ColumnFilterModel | null = null;
    const hasV = value !== '' && value != null;
    if (kind === 'number') {
      if (hasV) model = {
        filterType: 'number', type: op, filter: Number(value),
        filterTo: op === 'inRange' && valueTo !== '' ? Number(valueTo) : undefined,
      };
    } else if (kind === 'date') {
      if (hasV) model = {
        filterType: 'date', type: op, dateFrom: value, dateTo: op === 'inRange' ? valueTo : '',
      };
    } else if (hasV) {
      model = { filterType: 'text', type: op, filter: value };
    }
    this.state.filter.setColumnFilter(col.colId, model);
    this.commitFilterChange();
  }

  // ---- floating filters (Phase 5) ----
  private filterDebounce: any = null;

  get hasFloatingFilters(): boolean {
    return this.allVisibleColumns.some(c => this.showsFloatingFilter(c));
  }

  showsFloatingFilter(col: Column): boolean {
    if (col.colDef.filter === false) return false;
    return col.colDef.floatingFilter ?? this.state.options.defaultColDef?.floatingFilter ?? false;
  }

  floatingFilterType(col: Column): 'text' | 'number' | 'date' {
    const f = col.colDef.filter;
    if (f === 'agNumberColumnFilter') return 'number';
    if (f === 'agDateColumnFilter') return 'date';
    return 'text';
  }

  floatingFilterValue(col: Column): string {
    const m = this.state.filter.getColumnModel(col.colId);
    return m?.filter ?? '';
  }

  onFloatingFilterInput(col: Column, value: string): void {
    const type = this.floatingFilterType(col);
    this.state.filter.setQuickColumnText(col.colId, value, type as any);
    if (this.filterDebounce) clearTimeout(this.filterDebounce);
    this.filterDebounce = setTimeout(() => {
      this.state.applyFilter();
      this.recomputeWindow();
      this.cdr.markForCheck();
      this.filterChanged.emit({ api: this.api, type: 'filterChanged' });
    }, 250);
  }

  /** Current value shown by the inline date floating-filter (the model's dateFrom). */
  floatingDateValue(col: Column): string {
    const m: any = this.state.filter.getColumnModel(col.colId);
    return (m && (m.dateFrom || '')) || '';
  }

  /**
   * Inline date floating-filter: picking a date sets a direct `equals` filter on that day;
   * clearing the field removes the filter. Advanced ops (before/after/range) stay behind the
   * funnel button popup.
   */
  onFloatingDateInput(col: Column, value: string): void {
    if (!value) this.state.filter.setColumnFilter(col.colId, null);
    else this.state.filter.setColumnFilter(col.colId, {
      filterType: 'date', type: 'equals', dateFrom: value, dateTo: '',
    } as any);
    this.commitFilterChange();
  }

  // ---- column filter popup (Set / Date / Number / Multi) ----
  filterPopupCol: Column | null = null;
  filterPopupMode: 'set' | 'date' | 'number' | 'multi' = 'set';
  filterPopupX = 0;
  filterPopupY = 0;
  filterSearch = '';
  filterOptions: { value: string; label: string; selected: boolean }[] = [];
  // date filter state
  dateCondition: 'equals' | 'lessThan' | 'greaterThan' | 'inRange' = 'equals';
  dateFrom = '';
  dateTo = '';
  // number filter state
  numberCondition: 'equals' | 'notEqual' | 'greaterThan' | 'greaterThanOrEqual' | 'lessThan' | 'lessThanOrEqual' | 'inRange' = 'equals';
  numberFrom: string | number = '';
  numberTo: string | number = '';
  // multi filter (text + set) state
  multiText = '';
  private filterOutside?: (e: MouseEvent) => void;

  filterModeFor(col: Column): 'set' | 'date' | 'number' | 'multi' {
    const f = col.colDef.filter;
    if (f === 'agDateColumnFilter') return 'date';
    if (f === 'agNumberColumnFilter') return 'number';
    if (f === 'agMultiColumnFilter') return 'multi';
    if (f === 'agSetColumnFilter') return 'set';
    return 'set';   // text/default → option picker
  }

  openFilterPopup(col: Column, ev: MouseEvent): void {
    ev.stopPropagation();
    if (!this.isBrowser) return;
    if (this.filterPopupCol === col) { this.closeFilterPopup(); return; }
    this.filterPopupCol = col;
    this.filterPopupMode = this.filterModeFor(col);
    const model = this.state.filter.getColumnModel(col.colId);

    if (this.filterPopupMode === 'date') {
      this.dateCondition = (model?.filterType === 'date' && (model.type as any)) || 'equals';
      this.dateFrom = model?.dateFrom || '';
      this.dateTo = model?.dateTo || '';
    } else if (this.filterPopupMode === 'number') {
      this.numberCondition = (model?.filterType === 'number' && (model.type as any)) || 'equals';
      this.numberFrom = model?.filter ?? '';
      this.numberTo = model?.filterTo ?? '';
    } else {
      // set or multi — both show a distinct-value option list
      this.filterSearch = '';
      const subs = model?.filterType === 'multi' ? model.filters || [] : [model];
      const setSub = subs.find(s => s?.filterType === 'set');
      const textSub = subs.find(s => s?.filterType === 'text');
      this.multiText = textSub?.filter ?? '';
      const selectedSet = setSub ? new Set((setSub.values || []).map(String)) : null;
      const distinct = this.state.filter.getDistinctValues(col, this.state.rowModel.getAllNodes());
      this.filterOptions = distinct.map(v => ({
        value: v, label: v === '' ? '(Blanks)' : v,
        selected: selectedSet ? selectedSet.has(v) : true,
      }));
    }

    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const root = this.popupHostRect();
    // Position relative to .bs-grid-root (the offset parent), clamping to its right edge so
    // a rightmost column's filter popup stays inside the grid. Height self-scrolls (max 320px).
    this.filterPopupX = Math.max(4, Math.min(rect.left - root.left, root.width - 234));
    this.filterPopupY = rect.bottom - root.top;
    this.cdr.markForCheck();
    this.zone.runOutsideAngular(() => {
      this.filterOutside = () => this.zone.run(() => this.closeFilterPopup());
      setTimeout(() => document.addEventListener('mousedown', this.filterOutside!, { once: true }), 0);
    });
  }

  applyDateFilter(): void {
    const col = this.filterPopupCol;
    if (!col) return;
    const hasFrom = !!this.dateFrom;
    const hasTo = !!this.dateTo;
    if (!hasFrom || (this.dateCondition === 'inRange' && !hasTo)) {
      this.state.filter.setColumnFilter(col.colId, null);
    } else {
      this.state.filter.setColumnFilter(col.colId, {
        filterType: 'date', type: this.dateCondition, dateFrom: this.dateFrom, dateTo: this.dateTo,
      });
    }
    this.commitFilterChange();
  }

  clearColumnFilter(): void {
    const col = this.filterPopupCol;
    if (!col) return;
    this.state.filter.setColumnFilter(col.colId, null);
    this.dateFrom = ''; this.dateTo = '';
    this.filterOptions.forEach(o => (o.selected = true));
    this.state.applyFilter();
    this.recomputeWindow();
    this.cdr.markForCheck();
    this.filterChanged.emit({ api: this.api, type: 'filterChanged' });
  }

  closeFilterPopup(): void {
    if (!this.filterPopupCol) return;
    this.filterPopupCol = null;
    if (this.filterOutside) document.removeEventListener('mousedown', this.filterOutside);
    this.cdr.markForCheck();
  }

  get visibleFilterOptions() {
    const q = this.filterSearch.toLowerCase().trim();
    return q ? this.filterOptions.filter(o => o.label.toLowerCase().includes(q)) : this.filterOptions;
  }

  get selectAllState(): 'checked' | 'unchecked' | 'indeterminate' {
    const opts = this.visibleFilterOptions;
    const sel = opts.filter(o => o.selected).length;
    if (sel === 0) return 'unchecked';
    if (sel === opts.length) return 'checked';
    return 'indeterminate';
  }

  toggleSelectAllOptions(): void {
    const target = this.selectAllState !== 'checked';
    for (const o of this.visibleFilterOptions) o.selected = target;
    this.applySetFilter();
  }

  toggleFilterOption(opt: { selected: boolean }): void {
    opt.selected = !opt.selected;
    this.applySetFilter();
  }

  /** apply set filter (and, in multi mode, combine with the text sub-filter). */
  applySetFilter(): void {
    const col = this.filterPopupCol;
    if (!col) return;
    const selected = this.filterOptions.filter(o => o.selected).map(o => o.value);
    const setActive = selected.length !== this.filterOptions.length;
    const setModel = setActive ? { filterType: 'set' as const, values: selected } : null;

    if (this.filterPopupMode === 'multi') {
      const textModel = this.multiText ? { filterType: 'text' as const, type: 'contains', filter: this.multiText } : null;
      const subs = [textModel, setModel].filter(Boolean) as any[];
      this.state.filter.setColumnFilter(col.colId, subs.length ? { filterType: 'multi', filters: subs } : null);
    } else {
      this.state.filter.setColumnFilter(col.colId, setModel);
    }
    this.commitFilterChange();
  }

  onMultiTextChange(text: string): void { this.multiText = text; this.applySetFilter(); }

  applyNumberFilter(): void {
    const col = this.filterPopupCol;
    if (!col) return;
    const hasFrom = this.numberFrom !== '' && this.numberFrom != null;
    const hasTo = this.numberTo !== '' && this.numberTo != null;
    if (!hasFrom || (this.numberCondition === 'inRange' && !hasTo)) {
      this.state.filter.setColumnFilter(col.colId, null);
    } else {
      this.state.filter.setColumnFilter(col.colId, {
        filterType: 'number', type: this.numberCondition,
        filter: Number(this.numberFrom), filterTo: hasTo ? Number(this.numberTo) : undefined,
      });
    }
    this.commitFilterChange();
  }

  private commitFilterChange(): void {
    this.state.applyFilter();
    this.recomputeWindow();
    this.cdr.markForCheck();
    this.filterChanged.emit({ api: this.api, type: 'filterChanged' });
  }

  columnHasActiveFilter(col: Column): boolean {
    return !!this.state.filter.getColumnModel(col.colId);
  }

  // ---- context menu (Phase 8) ----
  ctxOpen = false;
  ctxX = 0;
  ctxY = 0;
  ctxFlipSub = false;
  ctxItems: MenuItem[] = [];
  private ctxOutside?: (e: MouseEvent) => void;

  /** Right-click on a row cell — carries the exact node/column, then stops the event so the
   *  grid-wide handler below doesn't also fire. */
  onContextMenu(node: RowNode, col: Column, ev: MouseEvent): void {
    ev.stopPropagation();
    // Right-click must NEVER mutate the active cell range — AG's clipboard model reads whatever
    // getCellRanges() currently holds regardless of which cell you right-click on (drag a range,
    // then right-click anywhere to copy it). An earlier version of this collapsed the range to
    // the right-clicked cell when it fell outside the range, which silently destroyed the user's
    // selection and made "Copy" fall back to copying every rendered row × every column instead.
    if (node && col) this.cellContextMenu.emit(this.cellEvent('cellContextMenu', node, col, ev));
    this.showContextMenu(node, col, ev);
  }

  /** Right-click anywhere else in the grid (header, empty space below rows, gaps) — the menu
   *  still opens (node/column null), so context actions work across the whole grid, not just on
   *  rows. Native menu is left alone for editable inputs so paste etc. still work there. */
  onGridContextMenu(ev: MouseEvent): void {
    const t = ev.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t as any).isContentEditable)) return;
    const col = this.allVisibleColumns[0] || null;
    // Empty-space right-click carries no row, but the host still needs to know WHICH grid was
    // clicked — e.g. the analytics screen's (cellContextMenu) binding records which question to
    // export. Those bindings read their own template context (the local `question`), not this
    // payload, so emitting a null-node event is enough to make right-click-anywhere export work.
    // Built by hand (not cellEvent()) because that helper dereferences node.data / getValue().
    this.cellContextMenu.emit({
      api: this.api, node: null, data: null, rowIndex: -1, event: ev,
      type: 'cellContextMenu', column: col, colDef: col?.colDef, value: null,
    } as CellEvent);
    this.showContextMenu(null, col, ev);
  }

  private showContextMenu(node: RowNode | null, col: Column | null, ev: MouseEvent): void {
    if (!this.isBrowser || !this.getContextMenuItems) return;
    ev.preventDefault();
    const value = node && col ? this.state.values.getValue(col, node) : null;
    const raw = this.getContextMenuItems({
      node, column: col, value, api: this.api,
      defaultItems: ['copy', 'copyWithHeaders', 'csvExport', 'excelExport'],
    }) || [];
    this.ctxItems = raw.map((it: any) => this.mapContextItem(it)).filter(Boolean) as MenuItem[];
    if (!this.ctxItems.length) return;
    const pos = this.popupPosition(
      { left: ev.clientX, top: ev.clientY, bottom: ev.clientY }, this.ctxItems.length, 200);
    this.ctxX = pos.x;
    this.ctxY = pos.y;
    this.ctxFlipSub = pos.flipSub;
    this.ctxOpen = true;
    this.cdr.markForCheck();
    this.zone.runOutsideAngular(() => {
      this.ctxOutside = () => this.zone.run(() => { this.ctxOpen = false; this.cdr.markForCheck(); });
      setTimeout(() => document.addEventListener('mousedown', this.ctxOutside!, { once: true }), 0);
    });
  }

  private mapContextItem(it: any): MenuItem | null {
    if (typeof it === 'string') {
      switch (it) {
        case 'separator': return { separator: true } as MenuItem;
        case 'csvExport': return { label: 'CSV Export', icon: '⭳', action: () => this.api.exportDataAsCsv() };
        case 'excelExport': return { label: 'Excel Export', icon: '⭳', action: () => this.api.exportDataAsExcel() };
        case 'copy': return { label: 'Copy', icon: '⧉', action: () => this.copySelectionToClipboard(false) };
        case 'copyWithHeaders': return { label: 'Copy with Headers', icon: '⧉', action: () => this.copySelectionToClipboard(true) };
        // Unsupported AG built-ins (e.g. 'chartRange', 'paste', 'export') are dropped rather
        // than shown disabled — the host reuses its AG menu config verbatim.
        default: return null;
      }
    }
    if (it && typeof it === 'object') {
      // Custom item, possibly with a nested subMenu (AG shape).
      const sub = (it.subMenu || it.submenu);
      const submenu = Array.isArray(sub)
        ? (sub.map((s: any) => this.mapContextItem(s)).filter(Boolean) as MenuItem[])
        : undefined;
      return {
        label: it.name ?? it.label,
        icon: it.icon,
        disabled: it.disabled,
        submenu: submenu && submenu.length ? submenu : undefined,
        action: it.action ? () => it.action() : undefined,
      };
    }
    return null;
  }

  runCtxItem(item: MenuItem): void { if (!item.disabled) item.action?.(); this.ctxOpen = false; }

  /**
   * Priority, verified against AG's real clipboard behavior (docs.ag-grid.com/angular-data-grid/
   * clipboard): a genuine multi-cell range always wins (AG: "select a range... Ctrl+C or
   * context-menu Copy... Excel-compatible tab-separated format"). Below that, BlockSurvey's own
   * checkbox-rows-copy is a pre-existing, deliberate feature independent of AG's actual default
   * (AG's `copySelectedRows` defaults to false — real AG would ignore checkbox selection here —
   * but this app never relied on that default and this workflow predates range selection, so it's
   * left as-is rather than removed as an unrequested behavior change). Only the BOTTOM fallback
   * changed: previously "nothing selected" copied every rendered row x every column, which has no
   * basis in AG at all (AG's true default with nothing selected is "copy only the focused cell").
   * A plain click always leaves a 1x1 range as its de-facto focused cell, so that now copies just
   * that cell; only if literally nothing was ever clicked is there truly nothing to copy.
   */
  private copySelectionToClipboard(withHeaders: boolean): void {
    if (!this.isBrowser) return;
    const ranges = this.enableRangeSelection ? this.state.rangeSelection.getRanges() : [];
    if (ranges.length && this.state.rangeSelection.isMultiCell()) { this.copyRangesToClipboard(ranges, withHeaders); return; }
    const selected = this.api.getSelectedNodes();
    if (selected.length) {
      const cols = this.allVisibleColumns;
      const lines: string[] = [];
      if (withHeaders) lines.push(cols.map(c => c.headerName).join('\t'));
      for (const n of selected) {
        lines.push(cols.map(c => {
          let v = this.state.values.getDisplayValue(c, n);
          if (this.processCellForClipboard) v = this.processCellForClipboard({ value: v, node: n, column: c, api: this.api });
          return v == null ? '' : String(v);
        }).join('\t'));
      }
      navigator.clipboard?.writeText(lines.join('\n')).catch(() => { });
      return;
    }
    if (ranges.length) { this.copyRangesToClipboard(ranges, withHeaders); return; }
  }

  /** Ctrl/Cmd+V into the grid (AG clipboard parity). Reads the native paste event, so no
   *  clipboard permission prompt. A multi-cell clipboard block is written from the top-left of
   *  the selected range (or the focused cell) across displayed rows/columns; a single value
   *  fills every cell of a multi-cell range. Only editable cells are written, each through
   *  processCellFromClipboard and the column's valueParser; the pasted block becomes the range. */
  onGridPaste(ev: ClipboardEvent): void {
    if (!this.isBrowser || !this.enableRangeSelection || this.editing) return;
    if (this.isInteractiveTarget(ev)) return;   // a filter input / editor keeps native paste
    const text = ev.clipboardData?.getData('text/plain');
    if (text == null || text === '') return;
    const range = this.state.rangeSelection;
    const ranges = range.getRanges();
    const first = ranges[0];
    const focus = this.keyboardFocusPos();
    const startRow = first ? Math.min(first.startRowIndex, first.endRowIndex) : focus?.rowIndex;
    const startColId = first ? first.columns[0] : focus?.colId;
    if (startRow == null || startColId == null) return;
    ev.preventDefault();

    const data = parseClipboardTsv(text);
    if (!data.length) return;
    const visible = this.allVisibleColumns.map(c => c.colId);
    const startCol = visible.indexOf(startColId);
    if (startCol < 0) return;

    // Single copied cell + multi-cell selection: fill the whole selection (AG behaviour).
    const single = data.length === 1 && data[0].length === 1;
    const targets: CellRange[] = single && ranges.length && range.isMultiCell()
      ? ranges
      : [{
          startRowIndex: startRow,
          endRowIndex: Math.min(startRow + data.length - 1, this.pageLastRow),
          columns: visible.slice(startCol, startCol + Math.max(...data.map(r => r.length))),
        } as CellRange];

    this.pasteStart.emit({ api: this.api, source: 'clipboard', type: 'pasteStart' });
    this.writeRanges(targets, (col, node) => {
      const t = targets.find(r => r.columns.includes(col.colId));
      let raw: string | undefined;
      if (single) raw = data[0][0];
      else if (t) raw = data[(node.rowIndex ?? 0) - t.startRowIndex]?.[t.columns.indexOf(col.colId)];
      if (raw === undefined) return undefined;
      return this.processCellFromClipboard
        ? this.processCellFromClipboard({ value: raw, node, column: col, api: this.api })
        : raw;
    });
    this.pasteEnd.emit({ api: this.api, source: 'clipboard', type: 'pasteEnd' });

    if (!single || !ranges.length || !range.isMultiCell()) {
      const t = targets[0];
      range.setOrderedColIds(visible);
      range.start(t.startRowIndex, t.columns[0]);
      range.extendTo(t.endRowIndex, t.columns[t.columns.length - 1]);
      range.end();
      this.setKeyboardFocus(t.startRowIndex, t.columns[0]);
      this.notifyCellSelectionChanged();
    }
    this.cdr.markForCheck();
  }

  /** Copy one or more rectangular cell ranges as TSV (tab per column, newline per row) — pastes
   *  back into a spreadsheet as a grid, matching what AG's range-selection Ctrl+C produced.
   *  Multiple ranges (Ctrl+drag multi-select) are copied as separate TSV blocks, one blank line
   *  apart, mirroring how a spreadsheet pastes a non-contiguous multi-range copy. */
  private copyRangesToClipboard(ranges: CellRange[], withHeaders: boolean): void {
    const blocks = ranges.map(range => this.rangeToTsv(range, withHeaders));
    navigator.clipboard?.writeText(blocks.join('\n\n')).catch(() => { });
  }

  private rangeToTsv(range: CellRange, withHeaders: boolean): string {
    const cols = range.columns.map(id => this.cols.getColumn(id)).filter((c): c is Column => !!c);
    const lines: string[] = [];
    if (withHeaders) lines.push(cols.map(c => c.headerName).join('\t'));
    for (let i = range.startRowIndex; i <= range.endRowIndex; i++) {
      const node = this.state.rowModel.getRow(i);
      if (!node) continue;
      lines.push(cols.map(c => {
        let v = this.state.values.getDisplayValue(c, node);
        if (this.processCellForClipboard) v = this.processCellForClipboard({ value: v, node, column: c, api: this.api });
        return v == null ? '' : String(v);
      }).join('\t'));
    }
    return lines.join('\n');
  }

  // ---- popup positioning (shared by header menu, context menu, filter popup) ----
  /** Bounding rect of .bs-grid-root — the offset parent for every popup. Falls back to the
   *  viewport if the root ref isn't ready yet (should not happen once the view is rendered). */
  private popupHostRect(): DOMRect {
    const host = this.rootRef?.nativeElement ?? this.viewportRef?.nativeElement;
    return host!.getBoundingClientRect();
  }

  /** Convert a screen-space anchor (a header button, or a right-click point) into
   *  root-relative {x, y}, clamped to the root's right edge and flipped above the anchor
   *  when the popup would spill past the root's bottom (root has overflow:hidden, so an
   *  un-flipped popup near the bottom would be clipped). Menu height is estimated from the
   *  item count — exact enough to pick a side; the popup still lays out at its natural size. */
  private popupPosition(
    anchor: { left: number; top: number; bottom: number },
    itemCount: number,
    width: number,
  ): { x: number; y: number; flipSub: boolean } {
    const root = this.popupHostRect();
    const estHeight = itemCount * 32 + 8;
    let x = anchor.left - root.left;
    x = Math.max(4, Math.min(x, root.width - width - 4));
    let y = anchor.bottom - root.top;
    if (y + estHeight > root.height && anchor.top - root.top > estHeight) {
      y = anchor.top - root.top - estHeight;   // flip: open upward from the anchor
    }
    y = Math.max(4, y);
    // Submenus (e.g. "Pin Column") open to the right at left:100%. Near the right edge that
    // flyout spills past the grid root, which has overflow:hidden, so it gets clipped/hidden.
    // Signal the template to open submenus leftward when there isn't room on the right.
    const SUBMENU_WIDTH = 180;
    const flipSub = x + width + SUBMENU_WIDTH > root.width;
    return { x, y, flipSub };
  }

  // ---- header 3-dot menu (Phase 4) ----
  menuColumn: Column | null = null;
  menuX = 0;
  menuY = 0;
  menuFlipSub = false;
  menuItems: MenuItem[] = [];
  private menuOutsideHandler?: (e: MouseEvent) => void;

  openHeaderMenu(col: Column, ev: MouseEvent): void {
    ev.stopPropagation();
    if (!this.isBrowser) return;
    if (this.menuColumn === col) { this.closeHeaderMenu(); return; }
    const rect = (ev.target as HTMLElement).getBoundingClientRect();
    this.menuColumn = col;
    this.menuItems = this.buildMenuItems(col);
    const pos = this.popupPosition(rect, this.menuItems.length, 200);
    this.menuX = pos.x;
    this.menuY = pos.y;
    this.menuFlipSub = pos.flipSub;
    this.cdr.markForCheck();
    // outside-click to close
    this.zone.runOutsideAngular(() => {
      this.menuOutsideHandler = () => this.zone.run(() => this.closeHeaderMenu());
      setTimeout(() => document.addEventListener('mousedown', this.menuOutsideHandler!, { once: true }), 0);
    });
  }

  closeHeaderMenu(): void {
    if (!this.menuColumn) return;
    this.menuColumn = null;
    if (this.menuOutsideHandler) document.removeEventListener('mousedown', this.menuOutsideHandler);
    this.cdr.markForCheck();
  }

  runMenuItem(item: MenuItem): void {
    if (item.disabled) return;
    item.action?.();
    if (!item.keepOpen) this.closeHeaderMenu();
  }

  private buildMenuItems(col: Column): MenuItem[] {
    const items: MenuItem[] = [];
    if (col.isSortable()) {
      items.push({ label: 'Sort Ascending', icon: '↑', action: () => this.setSort(col, 'asc') });
      items.push({ label: 'Sort Descending', icon: '↓', action: () => this.setSort(col, 'desc') });
      if (col.sort) items.push({ label: 'Clear Sort', action: () => this.setSort(col, null) });
      items.push({ separator: true } as MenuItem);
    }
    items.push({
      label: 'Pin Column', submenu: [
        { label: 'No Pin', checked: col.pinned == null, action: () => this.setPinned(col, null) },
        { label: 'Pin Left', checked: col.pinned === 'left', action: () => this.setPinned(col, 'left') },
        { label: 'Pin Right', checked: col.pinned === 'right', action: () => this.setPinned(col, 'right') },
      ],
    });
    items.push({ separator: true } as MenuItem);
    items.push({ label: 'Autosize This Column', action: () => this.autoSizeColumn(col) });
    items.push({ label: 'Autosize All Columns', action: () => this.autoSizeAllColumns() });
    items.push({ separator: true } as MenuItem);
    if (col.colId !== AUTO_GROUP_COL_ID) {
      items.push({
        label: col.rowGroup ? `Un-group by ${col.headerName}` : `Group by ${col.headerName}`,
        icon: '▤', action: () => this.toggleRowGroup(col),
      });
    }
    if (this.cols.isGrouping()) {
      items.push({ label: 'Expand All', action: () => this.setAllGroupsExpanded(true) });
      items.push({ label: 'Collapse All', action: () => this.setAllGroupsExpanded(false) });
    }
    items.push({ separator: true } as MenuItem);
    items.push({ label: 'Reset Columns', action: () => this.resetColumns() });
    return items;
  }

  /**
   * Reset columns to their original colDefs (restoring default pins/order/width), then emit
   * columnMoved + columnPinned so the host persists this reset state to localStorage — otherwise
   * the previously-saved (pre-reset) state would be restored on the next reload and the reset
   * wouldn't stick. Mirrors AG Grid, whose resetColumnState fires column events the host saves on.
   */
  resetColumns(): void {
    this.api.resetColumnState();
    this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
    this.recomputeWindow();
    this.cdr.markForCheck();
    this.columnPinned.emit({ api: this.api, type: 'columnPinned' });
    this.columnMoved.emit({ api: this.api, type: 'columnMoved' });
  }

  // ---- grouping (advanced) ----
  isAutoGroupCol(col: Column): boolean { return col.colId === AUTO_GROUP_COL_ID; }

  toggleRowGroup(col: Column): void {
    this.state.toggleRowGroup(col.colId);
    this.columnMoved.emit({ api: this.api, type: 'columnRowGroupChanged', column: col });
  }

  toggleGroup(node: RowNode, ev?: Event): void {
    ev?.stopPropagation();
    this.state.rowModel.toggleGroupExpanded(node);
    this.recomputeWindow();
    this.cdr.markForCheck();
  }

  setAllGroupsExpanded(expanded: boolean): void {
    this.state.rowModel.setAllGroupsExpanded(expanded);
    this.recomputeWindow();
    this.cdr.markForCheck();
  }

  /** display for a non-auto column on a group row: its aggregated value, if any. */
  groupAggDisplay(col: Column, node: RowNode): string {
    if (!node.aggData || !(col.colId in node.aggData)) return '';
    const v = node.aggData[col.colId];
    if (v == null) return '';
    const fmt = this.state.values.formatValue(col, node, v);
    if (fmt != null) return fmt;
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
    return String(v);
  }

  private setSort(col: Column, dir: 'asc' | 'desc' | null): void {
    // menu sets a single-column sort directly (clear others)
    for (const c of this.cols.columns) { if (c !== col) { c.sort = null; c.sortIndex = null; } }
    col.sort = dir;
    col.sortIndex = dir ? 0 : null;
    this.state.rowModel.refresh();
    this.recomputeWindow();
    this.cdr.markForCheck();
    this.sortChanged.emit({ api: this.api, type: 'sortChanged', column: col });
  }

  setPinned(col: Column, pinned: 'left' | 'right' | null): void {
    this.cols.setPinned(col.colId, pinned);
    this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
    this.keepPinnedColumnsNarrowerThanViewport();
    this.recomputeWindow();
    this.cdr.markForCheck();
    this.columnPinned.emit({ api: this.api, type: 'columnPinned', column: col });
  }

  // ---- inline editing (Phase 7) ----
  editing: { rowId: string; colId: string } | null = null;
  private editingCellCmp: any = null; // BsCellComponent currently editing, registered on edit start

  isCellEditing(col: Column, node: RowNode): boolean {
    return !!this.editing && this.editing.rowId === node.id && this.editing.colId === col.colId;
  }

  isColumnEditable(col: Column, node: RowNode): boolean {
    const e = col.colDef.editable;
    if (e == null) return false;
    if (typeof e === 'function') return !!e(this.state.values.buildBaseParams(node, col));
    return !!e;
  }

  registerEditingCell(cmp: any): void { this.editingCellCmp = cmp; }

  /**
   * Force all rendered cells to re-read their value and re-run their renderer, even when the row
   * node object is unchanged. Called by GridApi.refreshCells/redrawRows/applyTransaction and by
   * RowNode.setDataValue — the paths that mutate a node's data in place (AG's applyTransaction
   * keeps node identity). Without this, OnPush bs-cells keyed by node id never see an input change.
   */
  refreshCells(): void { this.renderTick++; this.invalidateAggregation(); this.cdr.markForCheck(); }

  onCellMouseDownForEdit(col: Column, node: RowNode, ev: MouseEvent): void {
    if (this.isInteractiveTarget(ev)) return;   // clicking a button/checkbox must not start an edit
    if (this.singleClickEdit && this.isColumnEditable(col, node)) {
      // let the click/selection happen, then enter edit — UNLESS this mousedown turns into a
      // cell-range drag (onCellRangeMouseDown/onCellRangeMove, below), in which case popping an
      // editor mid-drag would fight the range highlight. rangeDragMoved is set synchronously by
      // the drag's pointermove handler, which — being a real user gesture — reliably lands before
      // this deferred (0ms) callback runs.
      this.rangeDragMoved = false;
      setTimeout(() => {
        if (this.rangeDragMoved) return;
        this.startEditingCell({ rowNode: node, column: col });
      }, 0);
    }
  }

  onCellDblClickForEdit(col: Column, node: RowNode, ev?: MouseEvent): void {
    if (ev && this.isInteractiveTarget(ev)) return;
    if (!this.singleClickEdit && this.isColumnEditable(col, node)) {
      this.startEditingCell({ rowNode: node, column: col });
    }
  }

  // ---- cell range selection (docs/bs-grid/CELL-RANGE-SELECTION-SPEC-2026-07-30.md §3) ----
  private rangeMove?: (e: PointerEvent) => void;
  private rangeUp?: () => void;
  private rangeRaf: any = null;
  private rangeLastXY: { x: number; y: number } | null = null;
  private rangeAutoScroll: AutoScrollService | null = null;
  private rangeScrollHandler?: () => void;
  /** Where the in-flight drag's pointer listeners live (window), kept so teardown can detach
   *  exactly what it attached. */
  private rangeEventTarget: EventTarget | null = null;
  /** Set once a drag actually moves to a different cell than its anchor — lets the deferred
   *  singleClickEdit callback (above) tell a real drag apart from a plain click. */
  rangeDragMoved = false;

  onCellRangeMouseDown(col: Column, node: RowNode, ev: MouseEvent): void {
    if (!this.isBrowser || !this.enableRangeSelection || node.group) return;
    if (ev.button !== 0 || this.isInteractiveTarget(ev)) return;
    this.rootRef?.nativeElement.focus({ preventScroll: true });
    const range = this.state.rangeSelection;
    if (ev.shiftKey && range.hasRange()) {
      range.extendTo(node.rowIndex, col.colId);   // shift+click extends; focus stays at anchor
    } else {
      range.setOrderedColIds(this.allVisibleColumns.map(c => c.colId));
      // Ctrl/Cmd+drag (AG parity): adds an independent extra range, or — if the drag starts on
      // a cell already inside an existing range — deselects that range instead (splitting it
      // if the dragged rectangle doesn't cover it edge-to-edge). A plain drag (no modifier)
      // still clears every existing range first, same as before multi-range support.
      range.start(node.rowIndex, col.colId, ev.ctrlKey || ev.metaKey);
      this.setKeyboardFocus(node.rowIndex, col.colId);
    }
    this.notifyCellSelectionChanged();

    this.zone.runOutsideAngular(() => {
      // never leave a previous drag's listeners behind (a drag whose release the page never saw
      // would otherwise keep extending the range on every mouse move, forever)
      this.teardownRangeDrag();
      const vp = this.viewportRef?.nativeElement;
      this.rangeLastXY = { x: ev.clientX, y: ev.clientY };
      this.rangeAutoScroll = this.createRangeAutoScroll();

      // AG parity (rangeSelection/dragListenerFeature): the range drag listens on the document,
      // with NO pointer capture — capturing here would retarget the compatibility mouse events to
      // the grid root and kill the cell's own click (active-row bar, single-click select).
      const target: EventTarget = window;
      this.rangeEventTarget = target;

      this.rangeMove = (e: PointerEvent) => {
        // A release the page never saw — it happened over an iframe (Intercom's launcher sits over
        // the grid), outside the browser window, or was eaten by a native drag. Firefox in
        // particular delivers no pointerup there, and without this the drag would keep extending
        // the range on every later mouse move. The first move with no button held ends it.
        if (e.buttons === 0) { this.rangeUp?.(); return; }
        this.rangeLastXY = { x: e.clientX, y: e.clientY };
        this.rangeAutoScroll?.check(e);
        if (this.rangeRaf != null) return;
        this.rangeRaf = requestAnimationFrame(() => {
          this.rangeRaf = null;
          this.extendRangeToPointer();
        });
      };
      // AG parity (rangeService.onBodyScroll): while dragging, ANY viewport scroll — the user's
      // own wheel or an auto-scroll tick — re-extends the range from the held pointer position.
      this.rangeScrollHandler = () => this.extendRangeToPointer();
      vp?.addEventListener('scroll', this.rangeScrollHandler, { passive: true });
      this.rangeUp = () => {
        // A release in the same frame as the last move would otherwise have its pending rAF
        // cancelled by the teardown, dropping the final extension (fast drag-and-release
        // selected only the anchor cell). Apply it now, before teardown clears rangeLastXY.
        if (this.rangeRaf != null) this.extendRangeToPointer();
        this.teardownRangeDrag();
        // No-op for a plain/additive-new-range drag; finalizes a Ctrl+drag DESELECT by
        // splicing the (possibly split) leftover pieces back into the selection.
        range.end();
        this.zone.run(() => this.notifyCellSelectionChanged());
      };
      target.addEventListener('pointermove', this.rangeMove as EventListener);
      target.addEventListener('pointerup', this.rangeUp as EventListener);
      // AG parity (BaseDragService onCancel): the browser taking the pointer — native drag,
      // gesture — ends the drag.
      target.addEventListener('pointercancel', this.rangeUp as EventListener);
    });
  }

  /** Remove every listener/timer the in-flight range drag owns. Safe to call with no drag running. */
  private teardownRangeDrag(): void {
    const target = this.rangeEventTarget;
    if (target) {
      if (this.rangeMove) target.removeEventListener('pointermove', this.rangeMove as EventListener);
      if (this.rangeUp) {
        target.removeEventListener('pointerup', this.rangeUp as EventListener);
        target.removeEventListener('pointercancel', this.rangeUp as EventListener);
      }
    }
    const vp = this.viewportRef?.nativeElement;
    if (vp && this.rangeScrollHandler) vp.removeEventListener('scroll', this.rangeScrollHandler);
    this.rangeAutoScroll?.ensureCleared();
    if (this.rangeRaf != null) { cancelAnimationFrame(this.rangeRaf); this.rangeRaf = null; }
    this.rangeMove = undefined;
    this.rangeUp = undefined;
    this.rangeScrollHandler = undefined;
    this.rangeAutoScroll = null;
    this.rangeEventTarget = null;
    this.rangeLastXY = null;
  }

  /** Extend the live range to the held pointer, clamped to the visible cell area — AG tracks the
   *  last cell the pointer actually hovered, so a pointer dragged past the edge selects only up to
   *  the edge row/column and auto-scroll (not the raw coordinate) walks the selection further. */
  private extendRangeToPointer(): void {
    const xy = this.rangeLastXY;
    if (!xy) return;
    const p = this.clampToCellArea(xy.x, xy.y);
    const hit = this.hitTestCell(p.x, p.y);
    if (hit && this.state.rangeSelection.extendTo(hit.rowIndex, hit.colId)) {
      this.rangeDragMoved = true;
      this.zone.run(() => this.notifyCellSelectionChanged());
    }
  }

  private clampToCellArea(x: number, y: number): { x: number; y: number } {
    const el = this.viewportRef?.nativeElement;
    if (!el) return { x, y };
    const r = el.getBoundingClientRect();
    const top = r.top + this.stickyHeaderHeight();
    return {
      x: Math.max(r.left + 1, Math.min(r.right - 1, x)),
      y: Math.max(top + 1, Math.min(r.bottom - 1, y)),
    };
  }

  /** Live height of the sticky header stack (pivot-group + header + floating-filter rows), which
   *  covers the top of the viewport. Measured, not derived — the floating row is content-sized. */
  private stickyHeaderHeight(): number {
    const el = this.viewportRef?.nativeElement;
    if (!el) return 0;
    const top = el.getBoundingClientRect().top;
    let bottom = top;
    el.querySelectorAll('.bs-grid-pivot-group-row, .bs-grid-header-row, .bs-grid-floating-row')
      .forEach(h => { bottom = Math.max(bottom, h.getBoundingClientRect().bottom); });
    return bottom - top;
  }

  /** AG's rangeService auto-scroll wiring: the viewport scrolls on both axes while a range drag
   *  is held near an edge; the sticky header stack is the top offset and BsGrid has no pinned
   *  bottom rows, so no bottom offset. */
  private createRangeAutoScroll(): AutoScrollService | null {
    const vp = this.viewportRef?.nativeElement;
    if (!vp) return null;
    return new AutoScrollService({
      scrollContainer: vp,
      scrollAxis: 'xy',
      getVerticalPosition: () => vp.scrollTop,
      setVerticalPosition: (position) => { vp.scrollTop = position; },
      getHorizontalPosition: () => vp.scrollLeft,
      setHorizontalPosition: (position) => { vp.scrollLeft = position; },
      shouldSkipHorizontalScroll: () => vp.scrollWidth <= vp.clientWidth,
      getTopOffset: () => this.stickyHeaderHeight(),
      // Extend on the tick itself, not only on the viewport's own scroll event, so a held-still
      // pointer keeps growing the range while auto-scroll walks the rows past it.
      onScrollCallback: () => this.extendRangeToPointer(),
    });
  }

  /** clientX/Y → the cell underneath, across pinned + center regions, independent of which
   *  center columns are currently mounted (virtualization) — hit-tests against the full column
   *  layout (`cols.left`/`cols.width`), not the rendered-window subset. */
  private hitTestCell(clientX: number, clientY: number): { rowIndex: number; colId: string } | null {
    const el = this.viewportRef?.nativeElement;
    const rowsEl = this.rowsLayerRef?.nativeElement;
    if (!el || !rowsEl || !this.totalRowCount) return null;
    const rect = el.getBoundingClientRect();

    // Row Y is measured against the rows layer's OWN rect, not the viewport's — the sticky
    // header (+ floating-filter/pivot-group rows, when present) reserve real space above it in
    // the canvas's normal flow, so a viewport-relative + scrollTop calc undercounts every row by
    // that reserved height. getBoundingClientRect() already reflects current scroll, so no manual
    // scrollTop math is needed here.
    const canvasY = clientY - rowsEl.getBoundingClientRect().top;
    const rowIndex = this.pageFirstRow
      + Math.max(0, Math.min(this.pageRowCount - 1, Math.floor(canvasY / this.rowHeightPx)));

    const canvasX = clientX - rect.left + el.scrollLeft;
    const leftWidth = this.cols.leftWidth;
    const rightWidth = this.cols.rightWidth;
    const totalWidth = this.totalWidth;
    let col: Column | undefined;
    if (this.cols.leftColumns.length && canvasX < leftWidth) {
      col = this.findColAt(this.cols.leftColumns, canvasX);
    } else if (this.cols.rightColumns.length && canvasX > totalWidth - rightWidth) {
      col = this.findColAt(this.cols.rightColumns, canvasX - (totalWidth - rightWidth));
    } else {
      col = this.findColAt(this.cols.centerColumns, canvasX - leftWidth);
    }
    return col ? { rowIndex, colId: col.colId } : null;
  }

  private findColAt(cols: Column[], localX: number): Column | undefined {
    if (!cols.length) return undefined;
    if (localX < 0) return cols[0];
    for (const c of cols) if (localX < c.left + c.width) return c;
    return cols[cols.length - 1];
  }

  /** Grid-level keyboard handling per docs/bs-grid/KEYBOARD-NAVIGATION-SPEC.md: arrow/Home/End/
   *  Page navigation, Shift(+Ctrl)+Arrow range extension, Enter/F2 edit, Space row-select,
   *  Ctrl/Cmd+C copy, Escape clear. Bound to the grid root so it stays scoped to this grid
   *  instance and never hijacks native copy/typing while a filter input or editor has focus. */
  onGridKeyDown(ev: KeyboardEvent): void {
    // Floating-filter Tab boundaries run BEFORE the interactive-target guard: the filter row
    // sits between headers and body in AG's tab order, and its edges hand focus back to the
    // grid (middle inputs keep native tabbing).
    if (ev.key === 'Tab' && this.handleFloatingFilterTab(ev)) return;
    if (this.handleCustomEditorKey(ev)) return;
    if (this.isInteractiveTarget(ev)) return;
    if (this.focusedHeaderColId && this.handleHeaderKey(ev)) return;
    const range = this.state.rangeSelection;
    const isCopy = (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'c';
    if (isCopy) {
      const ranges = range.getRanges();
      if (!ranges.length) return;   // no cell focused via range-select — leave native copy alone
      ev.preventDefault();
      // Ctrl+C is new behavior (BsGrid had no keyboard copy before), so it always acts on the
      // focused/selected range(s) — even a single cell — unlike the context-menu "Copy" item,
      // which must keep preferring checkbox-row-selection copy when there's no genuine
      // multi-cell range. Multi-range (Ctrl+drag) selections copy as separate TSV blocks.
      this.copyRangesToClipboard(ranges, false);
      return;
    }
    if (ev.key === 'Escape' && range.hasRange()) {
      range.clear();
      this.notifyCellSelectionChanged();
      return;
    }

    // AG focus model: cell actions (edit/space) and plain moves act on the FOCUSED cell (the
    // click/drag anchor); shift-extension grows from the range's free corner.
    const corner = this.enableRangeSelection ? range.getFocus() : null;
    const focusPos = this.keyboardFocusPos();
    const pos = focusPos ?? (corner ? { rowIndex: corner.rowIndex, colId: corner.colId } : null);
    if (!pos) return;
    const node = this.state.rowModel.getRow(pos.rowIndex);

    // AG: "Pressing the F2 or Enter key on a cell will put the cell into edit mode"; Enter on
    // a group row expands/collapses it instead.
    if (ev.key === 'Enter' || ev.key === 'F2') {
      if (!node || this.editing) return;
      if (node.group) {
        if (ev.key === 'Enter') { ev.preventDefault(); this.toggleGroup(node, ev); }
        return;
      }
      const col = this.cols.getColumn(pos.colId);
      if (col && this.isColumnEditable(col, node)) {
        ev.preventDefault();
        this.startEditingCell({ rowNode: node, column: col });
      }
      return;
    }

    // AG: Delete "clears all cells in the selected range by setting values to null", firing
    // cellSelectionDeleteStart/End; only editable cells are touched, so read-only grids are safe.
    if (ev.key === 'Delete') {
      if (!this.enableRangeSelection) return;
      const ranges = range.getRanges();
      if (!ranges.length) return;
      ev.preventDefault();
      this.cellSelectionDeleteStart.emit({ api: this.api, type: 'cellSelectionDeleteStart' });
      this.writeRanges(ranges, () => null);
      this.cellSelectionDeleteEnd.emit({ api: this.api, type: 'cellSelectionDeleteEnd' });
      return;
    }

    // AG: Ctrl+D "copies top row values to all other rows in multi-row selection" (fill down).
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'd') {
      if (!this.enableRangeSelection) return;
      const ranges = range.getRanges().filter(r => r.endRowIndex > r.startRowIndex);
      if (!ranges.length) return;
      ev.preventDefault();
      for (const r of ranges) {
        const top = this.state.rowModel.getRow(r.startRowIndex);
        if (!top || top.group) continue;
        const topValues = new Map<string, any>();
        for (const colId of r.columns) {
          const col = this.cols.getColumn(colId);
          if (col) topValues.set(colId, this.state.values.getValue(col, top));
        }
        this.writeRanges(
          [{ ...r, startRowIndex: r.startRowIndex + 1 }],
          (col) => topValues.has(col.colId) ? topValues.get(col.colId) : undefined,
        );
      }
      return;
    }

    // AG: "Pressing the Space key when focusing a cell will select the cell's row, or deselect
    // the row if already selected"; multi-select mode keeps other selections.
    if (ev.key === ' ') {
      if (!node || node.group || !this.rowSelection) return;
      ev.preventDefault();
      this.state.selection.toggle(node);
      this.cdr.markForCheck();
      this.emitSelectionChanged('spaceKey');
      return;
    }

    // AG: "If a cell on the first grid row is focused and you press ↑, the focus will be moved
    // into the grid header."
    if (ev.key === 'ArrowUp' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey && pos.rowIndex === this.pageFirstRow) {
      ev.preventDefault();
      this.setHeaderFocus(pos.colId);
      return;
    }

    // AG: "Tab will move the focus horizontally until the last cell and then move on to the
    // next row" (Shift+Tab reverses). Past the grid's very first/last cell the event is left
    // to the browser so focus exits the grid to the next element on the page.
    if (ev.key === 'Tab') {
      const tabCols = this.allVisibleColumns.map(c => c.colId);
      const idx = tabCols.indexOf(pos.colId);
      if (idx === -1) return;
      let r = pos.rowIndex;
      let c = idx + (ev.shiftKey ? -1 : 1);
      if (c >= tabCols.length) { c = 0; r++; }
      else if (c < 0) { c = tabCols.length - 1; r--; }
      if (r < this.pageFirstRow) {
        // Shift+Tab off the first cell walks back up AG's tab order: filter row, else headers.
        ev.preventDefault();
        this.focusedCell = null;
        if (!this.focusFloatingFilter('last')) this.setHeaderFocus(tabCols[tabCols.length - 1]);
        this.cdr.markForCheck();
        return;
      }
      if (r > this.pageLastRow) return;   // exit the grid via browser default (AG: page's last row)
      ev.preventDefault();
      if (this.enableRangeSelection) {
        range.setOrderedColIds(tabCols);
        range.start(r, tabCols[c]);
      }
      this.setKeyboardFocus(r, tabCols[c]);
      this.ensureIndexVisible(r);
      this.ensureColumnVisible(tabCols[c]);
      this.notifyCellSelectionChanged();
      return;
    }

    // Shift = extend the selection (range grids only); anything else moves/collapses focus.
    const extend = ev.shiftKey && this.enableRangeSelection;
    const origin = extend && corner ? { rowIndex: corner.rowIndex, colId: corner.colId } : pos;
    const target = this.resolveNavTarget(ev, origin);
    if (!target) return;
    ev.preventDefault();
    if (extend) {
      // AG: "holding Shift and using the arrow keys will create a range starting from the
      // focused cell" — so with no live range yet, anchor one at the focused cell first.
      if (!corner) {
        range.setOrderedColIds(this.allVisibleColumns.map(c => c.colId));
        range.start(pos.rowIndex, pos.colId);
      }
      range.extendTo(target.rowIndex, target.colId);
    } else {
      if (this.enableRangeSelection) {
        // start() re-anchors, collapsing any range to the new single cell (AG plain-move).
        range.setOrderedColIds(this.allVisibleColumns.map(c => c.colId));
        range.start(target.rowIndex, target.colId);
      }
      this.setKeyboardFocus(target.rowIndex, target.colId);
    }
    this.ensureIndexVisible(target.rowIndex);
    this.ensureColumnVisible(target.colId);
    this.notifyCellSelectionChanged();
  }

  // ---- header keyboard focus (AG: header cells are keyboard-focusable; docs §1.4) ----
  focusedHeaderColId: string | null = null;

  setHeaderFocus(colId: string | null): void {
    if (this.focusedHeaderColId === colId) return;
    this.focusedHeaderColId = colId;
    if (colId) this.focusedCell = null;   // focus lives in the header now
    this.cdr.markForCheck();
  }

  /** Keys while a header cell is focused. Returns true when the event was consumed. */
  private handleHeaderKey(ev: KeyboardEvent): boolean {
    const cols = this.allVisibleColumns;
    const idx = cols.findIndex(c => c.colId === this.focusedHeaderColId);
    if (idx === -1) { this.setHeaderFocus(null); return false; }
    const col = cols[idx];
    const alt = ev.altKey;

    // Alt+↓ opens the column menu; Alt+←/→ resizes; Shift+←/→ moves the column (AG header keys).
    if (alt && ev.key === 'ArrowDown') {
      ev.preventDefault();
      const el = this.rootRef?.nativeElement.querySelector(
        `.bs-grid-header-cell[aria-colindex="${idx + 1}"]`) as HTMLElement | null;
      if (el) this.openHeaderMenu(col, { stopPropagation: () => { }, target: el } as any);
      return true;
    }
    if (alt && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault();
      if (!col.isResizable()) return true;
      col.flex = null;
      col.width = clampWidth(col.width + (ev.key === 'ArrowLeft' ? -16 : 16), col.minWidth, col.maxWidth);
      this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
      this.recomputeColWindow();
      this.cdr.markForCheck();
      this.columnResized.emit({ api: this.api, type: 'columnResized', column: col });
      return true;
    }
    if (ev.shiftKey && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault();
      if (!col.isMovable()) return true;
      const neighbor = cols[idx + (ev.key === 'ArrowLeft' ? -1 : 1)];
      if (!neighbor || neighbor.pinned !== col.pinned) return true;   // stay within the region
      const toIndex = this.cols.columns.findIndex(c => c.colId === neighbor.colId);
      if (toIndex === -1) return true;
      this.cols.moveColumn(col.colId, toIndex);
      this.cols.layout(this.viewportRef?.nativeElement.clientWidth || 0);
      this.recomputeColWindow();
      this.cdr.markForCheck();
      this.columnMoved.emit({ api: this.api, type: 'columnMoved', column: col });
      return true;
    }

    if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
      ev.preventDefault();
      const next = cols[idx + (ev.key === 'ArrowLeft' ? -1 : 1)];
      if (next) { this.setHeaderFocus(next.colId); this.ensureColumnVisible(next.colId); }
      return true;
    }
    // AG: ↓ from the (last) header row moves focus to the first grid row.
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (!this.totalRowCount) return true;
      const colId = col.colId;
      this.setHeaderFocus(null);
      const firstRow = this.pageFirstRow;
      if (this.enableRangeSelection) {
        this.state.rangeSelection.setOrderedColIds(cols.map(c => c.colId));
        this.state.rangeSelection.start(firstRow, colId);
      }
      this.setKeyboardFocus(firstRow, colId);
      this.ensureIndexVisible(firstRow);
      this.notifyCellSelectionChanged();
      return true;
    }
    // AG: Enter toggles sort, Shift+Enter multi-sort; Space toggles the header checkbox.
    if (ev.key === 'Enter') {
      ev.preventDefault();
      if (col.isSortable()) this.sortCycle(col, ev.shiftKey);
      return true;
    }
    if (ev.key === ' ') {
      ev.preventDefault();
      if (this.showsHeaderCheckbox(col)) {
        this.state.selection.toggleAll();
        this.cdr.markForCheck();
        this.emitSelectionChanged('checkboxSelected');
      }
      return true;
    }
    // Tab walks headers; past the last header it drops into the floating-filter row when one
    // exists, else the first body row (AG: "move on to the next row"); Shift+Tab past the
    // first header leaves via the browser default.
    if (ev.key === 'Tab') {
      const next = cols[idx + (ev.shiftKey ? -1 : 1)];
      if (next) {
        ev.preventDefault();
        this.setHeaderFocus(next.colId);
        this.ensureColumnVisible(next.colId);
        return true;
      }
      if (!ev.shiftKey) {
        if (this.focusFloatingFilter('first')) { ev.preventDefault(); this.setHeaderFocus(null); return true; }
        if (this.totalRowCount) {
          ev.preventDefault();
          const firstCol = cols[0];
          this.setHeaderFocus(null);
          this.setKeyboardFocus(this.pageFirstRow, firstCol.colId);
          this.ensureIndexVisible(this.pageFirstRow);
          return true;
        }
      }
      this.setHeaderFocus(null);   // leaving the grid — browser default
      return true;
    }
    return false;
  }

  private floatingFilterFocusables(): HTMLElement[] {
    const row = this.rootRef?.nativeElement.querySelector('.bs-grid-floating-row');
    if (!row) return [];
    return Array.from(row.querySelectorAll<HTMLElement>('input, select, button, [tabindex]'))
      .filter(e => !(e as any).disabled && e.offsetParent !== null);
  }

  private focusFloatingFilter(which: 'first' | 'last'): boolean {
    const els = this.floatingFilterFocusables();
    if (!els.length) return false;
    els[which === 'first' ? 0 : els.length - 1].focus();
    return true;
  }

  /** AG tab order: headers → floating-filter row → body. Consumes Tab only at the filter
   *  row's two edges; everything in between stays native. */
  private handleFloatingFilterTab(ev: KeyboardEvent): boolean {
    const row = this.rootRef?.nativeElement.querySelector('.bs-grid-floating-row');
    const t = ev.target as HTMLElement;
    if (!row || !t || !row.contains(t)) return false;
    const els = this.floatingFilterFocusables();
    if (!els.length) return false;
    if (!ev.shiftKey && t === els[els.length - 1]) {
      const first = this.allVisibleColumns[0];
      if (!this.totalRowCount || !first) return false;   // no body — browser default
      ev.preventDefault();
      this.rootRef?.nativeElement.focus({ preventScroll: true });
      this.setKeyboardFocus(this.pageFirstRow, first.colId);
      this.ensureIndexVisible(this.pageFirstRow);
      return true;
    }
    if (ev.shiftKey && t === els[0]) {
      const cols = this.allVisibleColumns;
      const last = cols[cols.length - 1];
      if (!last) return false;
      ev.preventDefault();
      this.rootRef?.nativeElement.focus({ preventScroll: true });
      this.setHeaderFocus(last.colId);
      this.ensureColumnVisible(last.colId);
      return true;
    }
    return false;
  }

  /** The standalone focused cell (AG's focused-cell model), clamped in case data shrank. */
  private keyboardFocusPos(): { rowIndex: number; colId: string } | null {
    if (!this.focusedCell) return null;
    const row = Math.max(this.pageFirstRow, Math.min(this.focusedCell.rowIndex, this.pageLastRow));
    return row < 0 || !this.pageRowCount ? null : { rowIndex: row, colId: this.focusedCell.colId };
  }

  /** Key → target cell, per the AG keyboard-navigation docs. Returns null for unhandled keys
   *  so the browser default (e.g. native scrolling) is preserved. */
  private resolveNavTarget(ev: KeyboardEvent, pos: { rowIndex: number; colId: string }): { rowIndex: number; colId: string } | null {
    const colIds = this.enableRangeSelection && this.state.rangeSelection.getOrderedColIds().length
      ? this.state.rangeSelection.getOrderedColIds()
      : this.allVisibleColumns.map(c => c.colId);
    const colIdx = colIds.indexOf(pos.colId);
    if (colIdx === -1 || !this.totalRowCount) return null;
    // AG CellNavigationService: with pagination every move is bounded to the current page.
    const firstRow = this.pageFirstRow;
    const lastRow = this.pageLastRow;
    const lastCol = colIds.length - 1;
    const clampRow = (r: number) => Math.max(firstRow, Math.min(lastRow, r));
    const ctrl = ev.ctrlKey || ev.metaKey;

    // AG: "Use Home and End to go to the first and last rows."
    if (ev.key === 'Home') return { rowIndex: firstRow, colId: pos.colId };
    if (ev.key === 'End') return { rowIndex: lastRow, colId: pos.colId };
    // AG: Page Up/Down scroll the grid one page, focus follows.
    if (ev.key === 'PageUp' || ev.key === 'PageDown') {
      const vh = this.viewportRef?.nativeElement.clientHeight || 400;
      const page = Math.max(1, Math.floor(vh / this.rowHeightPx) - 1);
      return { rowIndex: clampRow(pos.rowIndex + (ev.key === 'PageUp' ? -page : page)), colId: pos.colId };
    }

    const dirs: Record<string, [number, number]> = {
      ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1],
    };
    const dir = dirs[ev.key];
    if (!dir) return null;
    // Ctrl+Shift+Arrow extends to the grid edge (cell-selection docs); plain Ctrl+←/→ moves to
    // the start/end of the line (keyboard-navigation docs). Ctrl+↑/↓ isn't documented — steps.
    const jump = ctrl && (ev.shiftKey || dir[0] === 0);
    const rowIndex = dir[0] === 0 ? pos.rowIndex
      : jump ? (dir[0] < 0 ? firstRow : lastRow)
        : clampRow(pos.rowIndex + dir[0]);
    const nextColIdx = dir[1] === 0 ? colIdx
      : jump ? (dir[1] < 0 ? 0 : lastCol)
        : Math.max(0, Math.min(lastCol, colIdx + dir[1]));
    return { rowIndex, colId: colIds[nextColIdx] };
  }

  @Output() cellSelectionChanged = new EventEmitter<{ api: any; type: 'cellSelectionChanged' }>();
  @Output() cellSelectionDeleteStart = new EventEmitter<{ api: any; type: 'cellSelectionDeleteStart' }>();
  @Output() cellSelectionDeleteEnd = new EventEmitter<{ api: any; type: 'cellSelectionDeleteEnd' }>();
  @Output() pasteStart = new EventEmitter<{ api: any; source: 'clipboard'; type: 'pasteStart' }>();
  @Output() pasteEnd = new EventEmitter<{ api: any; source: 'clipboard'; type: 'pasteEnd' }>();

  /** Central hook for every range mutation — keyboard, mouse-drag, and GridApi.addCellRange/
   *  clearCellSelection (called via state.view from grid-api.ts). */
  notifyCellSelectionChanged(): void {
    this.invalidateAggregation();
    this.cdr.markForCheck();
    this.cellSelectionChanged.emit({ api: this.api, type: 'cellSelectionChanged' });
  }

  isCellInRange(col: Column, node: RowNode): boolean {
    return this.enableRangeSelection && this.state.rangeSelection.isMultiCell()
      && this.state.rangeSelection.isCellInRange(node.rowIndex, col.colId);
  }
  isRangeEdge(col: Column, node: RowNode, edge: 'top' | 'right' | 'bottom' | 'left'): boolean {
    return this.isCellInRange(col, node) && this.state.rangeSelection.isRangeEdge(node.rowIndex, col.colId, edge);
  }
  /** AG parity: the clicked/focused cell always gets a thin focus ring (AG's `ag-cell-focus`),
   *  independent of whether the selection is a real multi-cell range — unlike isCellInRange,
   *  NOT gated on isMultiCell(). Safe to show on every plain click because the CSS for this is
   *  outline-only (no background change), so it can never blot out row-level tinting the way an
   *  opaque anchor fill previously did. */
  isRangeAnchor(col: Column, node: RowNode): boolean {
    return this.enableRangeSelection && this.state.rangeSelection.isAnchorCell(node.rowIndex, col.colId);
  }

  /** Selection-status aggregation ("easier counting"), AG's agAggregationComponent: Count over
   *  every non-empty selected cell WHATEVER its type, sum/min/max/avg over the numeric subset.
   *  Shown only when the host's statusBar config includes an aggregation panel. */
  get showsRangeAggregation(): boolean {
    if (!this.enableRangeSelection || !this.state.rangeSelection.isMultiCell()) return false;
    const panels = this.statusBar?.statusPanels || [];
    return panels.some(p => p?.statusPanel === 'agAggregationComponent');
  }
  get rangeAggregation(): RangeAggregation | null {
    const ranges = this.state.rangeSelection.getRanges();
    if (!ranges.length) return null;
    // memoized: this getter is read on every CD pass, and a large selection is O(cells)
    if (!this.aggCacheValid) {
      this.aggCache = computeRangeAggregation(this.selectedRangeValues(ranges));
      this.aggCacheValid = true;
    }
    return this.aggCache;
  }
  private aggCache: RangeAggregation | null = null;
  private aggCacheValid = false;
  private invalidateAggregation(): void { this.aggCacheValid = false; }

  /** Values of every cell in the given ranges, deduped — a cell shared by two ranges (a new
   *  additive range dragged over an existing one) is aggregated once, as in AG. */
  private *selectedRangeValues(ranges: CellRange[]): Generator<any> {
    const seen = new Set<string>();
    for (const range of ranges) {
      const cols = range.columns.map(id => this.cols.getColumn(id)).filter((c): c is Column => !!c);
      for (let i = range.startRowIndex; i <= range.endRowIndex; i++) {
        const node = this.state.rowModel.getRow(i);
        if (!node || node.group) continue;
        for (const c of cols) {
          const key = i + '|' + c.colId;
          if (seen.has(key)) continue;
          seen.add(key);
          yield this.state.values.getValue(c, node);
        }
      }
    }
  }

  /**
   * True when the click originated on an interactive control inside the row/cell (checkbox,
   * button, link, form field, or a cell-renderer's button). Such clicks must take priority: they
   * should NOT be treated as a row click/selection or trigger inline editing. Fixes checkbox
   * deselect being read as a row click, and button clicks in edit mode being swallowed by the row.
   */
  private isInteractiveTarget(ev: Event): boolean {
    let el = ev.target as HTMLElement | null;
    for (let i = 0; el && i < 8; i++) {
      if (el.classList && (el.classList.contains('bs-grid-row') || el.classList.contains('bs-grid-cell'))) break;
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL') return true;
      if (el.getAttribute && el.getAttribute('role') === 'button') return true;
      el = el.parentElement;
    }
    return false;
  }

  startEditingCell(params: { rowNode?: RowNode; column?: Column; rowIndex?: number; colKey?: string }): void {
    const node = params.rowNode ?? (params.rowIndex != null ? this.state.rowModel.getRow(params.rowIndex) : undefined);
    const col = params.column ?? (params.colKey ? this.cols.getColumn(params.colKey) : undefined);
    if (!node || !col) return;
    if (this.editing) this.stopEditing(false);
    this.editing = { rowId: node.id, colId: col.colId };
    // AG: the cell being edited is always the focused cell (Tab-to-next-edit moves focus too).
    this.setKeyboardFocus(node.rowIndex, col.colId);
    this.cdr.markForCheck();
    this.cellEditingStarted.emit(this.cellEvent('cellEditingStarted', node, col));
  }

  stopEditing(cancel = false): void {
    if (!this.editing) return;
    const node = this.state.rowModel.getRowById(this.editing.rowId);
    const col = this.cols.getColumn(this.editing.colId);
    const cmp = this.editingCellCmp;
    this.editingCellCmp = null;
    this.editing = null;

    if (!cancel && cmp && node && col) {
      const oldValue = this.state.values.getValue(col, node);
      const newValue = cmp.commitValue?.();
      if (newValue !== undefined) {
        const changed = this.state.values.setValue(col, node, newValue);
        if (changed) {
          this.state.rowModel.refreshAggregates();   // AG: re-aggregate only, no re-sort/filter
          this.invalidateAggregation();   // a status-bar sum over this cell must re-read it
          this.recomputeWindow();
          const ev = this.cellEvent('cellValueChanged', node, col) as any;
          ev.oldValue = oldValue; ev.newValue = this.state.values.getValue(col, node);
          this.cellValueChanged.emit(ev);
        }
      }
    }
    this.cdr.markForCheck();
  }

  getEditingCells(): any[] {
    return this.editing ? [{ rowIndex: this.state.rowModel.getRowById(this.editing.rowId)?.rowIndex, column: this.cols.getColumn(this.editing.colId) }] : [];
  }

  /**
   * Editor keyboard nav (AG): Tab → commit + edit the next editable cell (Shift+Tab =
   * previous), wrapping across rows; Enter → commit and keep focus (see handleEditorEnter).
   * Called by the editor elements in BsCell.
   */
  handleEditorTab(shift: boolean): void {
    if (!this.editing) return;
    const node = this.state.rowModel.getRowById(this.editing.rowId);
    const col = this.cols.getColumn(this.editing.colId);
    this.stopEditing(false);
    if (node && col) this.moveEditToAdjacent(node, col, shift ? -1 : 1);
  }

  /** Enter / Escape / Tab inside a CUSTOM editor component (built-in editors handle these on
   *  their own element first, which ends editing before the event bubbles here). AG routes these
   *  keys through the cell for every editor unless colDef.suppressKeyboardEvent returns true. */
  private handleCustomEditorKey(ev: KeyboardEvent): boolean {
    if (!this.editing || (ev.key !== 'Enter' && ev.key !== 'Escape' && ev.key !== 'Tab')) return false;
    const target = ev.target as HTMLElement | null;
    if (!target?.closest?.('bs-cell')) return false;   // e.g. a filter input, not the editor
    const node = this.state.rowModel.getRowById(this.editing.rowId);
    const col = this.cols.getColumn(this.editing.colId);
    const suppress = col?.colDef.suppressKeyboardEvent;
    if (typeof suppress === 'function' && node && col
      && suppress({ event: ev, editing: true, node, column: col, colDef: col.colDef, api: this.api, data: node.data })) {
      return true;   // the editor keeps the key (e.g. Enter picks an option in its own list)
    }
    if (ev.key === 'Escape') this.handleEditorEscape();
    else if (ev.key === 'Enter') { ev.preventDefault(); this.handleEditorEnter(ev.ctrlKey || ev.metaKey); }
    else { ev.preventDefault(); this.handleEditorTab(ev.shiftKey); }
    return true;
  }

  /** AG CellKeyboardListenerFeature.onEscapeKeyDown: cancel the edit, then give browser focus
   *  back to the edited cell so arrow keys / Enter keep working on the grid. */
  handleEditorEscape(): void {
    if (!this.editing) return;
    const node = this.state.rowModel.getRowById(this.editing.rowId);
    const colId = this.editing.colId;
    this.stopEditing(true);
    if (node) this.setKeyboardFocus(node.rowIndex, colId);
    this.rootRef?.nativeElement.focus({ preventScroll: true });
  }

  handleEditorEnter(bulk = false): void {
    if (!this.editing) return;
    const node = this.state.rowModel.getRowById(this.editing.rowId);
    const col = this.cols.getColumn(this.editing.colId);
    this.stopEditing(false);
    if (!node || !col) return;
    // AG: Ctrl+Enter "sets the new value of the edited cell to all the editable cells in the
    // selected range" — bulk-apply instead of moving down.
    if (bulk && this.enableRangeSelection) { this.applyValueToRanges(col, node); return; }
    // AG CellCtrl.stopEditingAndFocus + navigateAfterEdit: Enter commits and keeps focus on the
    // edited cell. Only with enterNavigatesVerticallyAfterEdit (v31+) / enterMovesDownAfterEdit
    // (≤v30) does focus move down one cell — and even then nothing starts editing.
    const o = this.state.options as any;
    const moveDown = !!(o.enterNavigatesVerticallyAfterEdit ?? o.enterMovesDownAfterEdit);
    const row = moveDown ? Math.min(node.rowIndex + 1, this.pageLastRow) : node.rowIndex;
    if (this.enableRangeSelection) {
      this.state.rangeSelection.setOrderedColIds(this.allVisibleColumns.map(c => c.colId));
      this.state.rangeSelection.start(row, col.colId);
    }
    this.setKeyboardFocus(row, col.colId);
    this.rootRef?.nativeElement.focus({ preventScroll: true });   // keep arrows/Enter on the grid
    this.ensureIndexVisible(row);
    this.notifyCellSelectionChanged();
  }

  /** Bulk-apply the committed value of (srcCol, srcNode) to every other editable cell in the
   *  current selection (Ctrl+Enter). One cellValueChanged per changed cell, like AG. */
  private applyValueToRanges(srcCol: Column, srcNode: RowNode): void {
    const ranges = this.state.rangeSelection.getRanges();
    if (!ranges.length) return;
    const value = this.state.values.getValue(srcCol, srcNode);
    this.writeRanges(ranges, (col, node) =>
      col.colId === srcCol.colId && node.id === srcNode.id ? undefined : value);
  }

  /** Shared bulk-write for Delete / Ctrl+D / Ctrl+Enter: valueFor returns the value to write
   *  for each editable leaf cell, or undefined to skip. Refreshes once, then emits one
   *  cellValueChanged per changed cell. */
  private writeRanges(ranges: CellRange[], valueFor: (col: Column, node: RowNode) => any): void {
    const writes: Array<{ col: Column; node: RowNode; oldValue: any }> = [];
    const seen = new Set<string>();
    for (const r of ranges) {
      for (let ri = r.startRowIndex; ri <= r.endRowIndex; ri++) {
        const node = this.state.rowModel.getRow(ri);
        if (!node || node.group) continue;
        for (const colId of r.columns) {
          const key = ri + '|' + colId;
          if (seen.has(key)) continue;
          seen.add(key);
          const col = this.cols.getColumn(colId);
          if (!col || !this.isColumnEditable(col, node)) continue;   // AG only touches editable cells
          const value = valueFor(col, node);
          if (value === undefined) continue;
          const oldValue = this.state.values.getValue(col, node);
          if (this.state.values.setValue(col, node, value)) writes.push({ col, node, oldValue });
        }
      }
    }
    if (!writes.length) return;
    // AG clipboard/fill: one batched change detection — re-aggregate, don't re-sort or re-filter.
    this.state.rowModel.refreshAggregates();
    this.recomputeWindow();
    for (const w of writes) {
      const e = this.cellEvent('cellValueChanged', w.node, w.col) as any;
      e.oldValue = w.oldValue; e.newValue = this.state.values.getValue(w.col, w.node);
      this.cellValueChanged.emit(e);
    }
    // Values changed in place on the same row nodes: bs-cell is OnPush and keyed by node id, so
    // bump renderTick (via refreshCells) or the cells keep showing the old text. Also drops the
    // cached status-bar aggregation, which summed the old values.
    this.refreshCells();
  }

  private editableColumns(): Column[] {
    return this.allVisibleColumns.filter(c => !this.isAutoGroupCol(c));
  }

  private moveEditToAdjacent(node: RowNode, col: Column, dir: 1 | -1): void {
    const cols = this.editableColumns();
    const displayed = this.state.rowModel.getDisplayedNodes();
    let ci = cols.indexOf(col);
    let ri = node.rowIndex;
    for (let steps = 0; steps < cols.length * displayed.length + 1; steps++) {
      ci += dir;
      if (ci >= cols.length) { ci = 0; ri++; }
      else if (ci < 0) { ci = cols.length - 1; ri--; }
      if (ri < 0 || ri >= displayed.length) return;   // hit the edge
      const nextNode = displayed[ri];
      const nextCol = cols[ci];
      if (nextNode && !nextNode.group && this.isColumnEditable(nextCol, nextNode)) {
        this.startEditingCell({ rowNode: nextNode, column: nextCol });
        return;
      }
    }
  }

  // ---- selection (Phase 6) ----
  get hasCheckboxColumn(): boolean {
    return this.allVisibleColumns.some(c => !!c.colDef.checkboxSelection);
  }
  showsCheckbox(col: Column): boolean { return !!col.colDef.checkboxSelection; }
  showsHeaderCheckbox(col: Column): boolean { return !!col.colDef.headerCheckboxSelection; }
  isSelected(node: RowNode): boolean { return this.state.selection.isSelected(node); }

  // Current / active row (focus cue). Distinct from selection — see the field declaration.
  isActiveRow(node: RowNode): boolean {
    return this.highlightRowOnClick && this.activeRowId != null && node.id === this.activeRowId;
  }
  private setActiveRow(node: RowNode): void {
    if (!this.highlightRowOnClick || this.activeRowId === node.id) return;
    this.activeRowId = node.id;
    this.cdr.markForCheck();
  }

  headerCheckboxState(): 'checked' | 'unchecked' | 'indeterminate' {
    return this.state.selection.headerState();
  }

  onCheckboxToggle(node: RowNode, ev: MouseEvent): void {
    ev.stopPropagation();
    this.state.selection.handleClick(node, node.rowIndex, {
      ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey, fromCheckbox: true,
    });
    this.cdr.markForCheck();
    this.emitSelectionChanged('checkboxSelected');
    this.rowSelected.emit(this.rowEvent('rowSelected', node, ev));
  }

  onHeaderCheckboxToggle(ev: MouseEvent): void {
    ev.stopPropagation();
    this.state.selection.toggleAll();
    this.cdr.markForCheck();
    this.emitSelectionChanged('checkboxSelected');
  }

  private emitSelectionChanged(source: string): void {
    this.selectionChanged.emit({ api: this.api, source, type: 'selectionChanged' });
  }

  private selectOnRowClick(node: RowNode, ev: MouseEvent): void {
    if (!this.rowSelection || this.suppressRowClickSelection) return;
    this.state.selection.handleClick(node, node.rowIndex, {
      ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey,
    });
    this.cdr.markForCheck();
    this.emitSelectionChanged('rowClicked');
  }

  // ---- events ----
  onRowClick(node: RowNode, col: Column, ev: MouseEvent): void {
    if (this.isInteractiveTarget(ev)) return;   // checkbox/button clicks take priority over row click
    if (node.group) { this.toggleGroup(node, ev); return; }   // group rows expand/collapse
    // Mark the current row immediately (before the dblclick timer) so the accent bar tracks the
    // click with zero perceived latency; the rowClicked EVENT still waits to disambiguate dblclick.
    this.setActiveRow(node);
    // Range-enabled grids set focus in onCellRangeMouseDown (shift-click must keep the anchor).
    if (!this.enableRangeSelection) this.setKeyboardFocus(node.rowIndex, col.colId);
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.selectOnRowClick(node, ev);
      this.rowClicked.emit(this.rowEvent('rowClicked', node, ev));
      this.cellClicked.emit(this.cellEvent('cellClicked', node, col, ev));
    }, 220);
  }

  onRowDblClick(node: RowNode, col: Column, ev: MouseEvent): void {
    if (this.isInteractiveTarget(ev)) return;   // button/checkbox dbl-click must not open the row
    if (this.clickTimer) { clearTimeout(this.clickTimer); this.clickTimer = null; }
    this.rowDoubleClicked.emit(this.rowEvent('rowDoubleClicked', node, ev));
    this.cellDoubleClicked.emit(this.cellEvent('cellDoubleClicked', node, col, ev));
  }

  private rowEvent(type: string, node: RowNode, ev?: Event): RowEvent {
    return { api: this.api, node, data: node.data, rowIndex: node.rowIndex, event: ev, type };
  }
  private cellEvent(type: string, node: RowNode, col: Column, ev?: Event): CellEvent {
    return {
      ...this.rowEvent(type, node, ev),
      column: col, colDef: col.colDef, value: this.state.values.getValue(col, node),
    };
  }

  // ---- imperative hooks called by GridApi (need DOM/viewport, so they live here) ----
  hookSizeColumnsToFit(): void {
    if (!this.isBrowser) return;
    this.cols.sizeColumnsToFit(this.viewportRef?.nativeElement.clientWidth || 0);
    this.recomputeColWindow();   // widths changed → rendered window offsets shift
    this.cdr.markForCheck();
  }

  ensureColumnVisible(colId: string): void {
    if (!this.isBrowser) return;
    const el = this.viewportRef?.nativeElement;
    const col = this.cols.getColumn(colId);
    if (!el || !col || col.pinned) return;                 // pinned cols are always visible
    const left = this.cols.leftWidth + col.left;
    const right = left + col.width;
    const viewLeft = el.scrollLeft + this.cols.leftWidth;
    const viewRight = el.scrollLeft + el.clientWidth - this.cols.rightWidth;
    if (left < viewLeft) el.scrollLeft = col.left;
    else if (right > viewRight) el.scrollLeft = col.left + col.width - (el.clientWidth - this.cols.leftWidth - this.cols.rightWidth);
    else return;
    // Programmatic scroll: recompute the column window synchronously so a following render
    // (e.g. setFocusedCell) targets a column that is actually in the rendered window — the
    // native scroll event only lands on the next rAF tick.
    this.onScrollPublic();
  }

  ensureIndexVisible(index: number): void {
    if (!this.isBrowser) return;
    const el = this.viewportRef?.nativeElement;
    if (!el) return;
    if (this.paginationActive && (index < this.pageFirstRow || index > this.pageLastRow)) {
      // AG GridBodyScrollFeature: it jumps to the row's page only when the panel is suppressed
      // (the app owns paging); with the panel shown the user's page choice is left alone.
      if (!this.showPaginationPanel && index >= 0 && index < this.totalRowCount) {
        this.paginationGoToPage(Math.floor(index / this.pageSize));
      } else {
        return;
      }
    }
    const top = (index - this.pageFirstRow) * this.rowHeightPx;
    const bottom = top + this.rowHeightPx;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
    this.onScrollPublic();
  }

  setFocusedCell(rowIndex: number, colId: string): void {
    this.ensureIndexVisible(rowIndex);
    this.ensureColumnVisible(colId);
    this.setKeyboardFocus(rowIndex, colId);
  }
  focusedCell: { rowIndex: number; colId: string } | null = null;
  isFocusedCell(col: Column, node: RowNode): boolean {
    return !!this.focusedCell && this.focusedCell.rowIndex === node.rowIndex && this.focusedCell.colId === col.colId;
  }

  @Output() cellFocused = new EventEmitter<{ api: any; rowIndex: number; column: Column | undefined; type: 'cellFocused' }>();

  setKeyboardFocus(rowIndex: number, colId: string): void {
    this.focusedHeaderColId = null;   // cell focus always displaces header focus
    if (this.focusedCell && this.focusedCell.rowIndex === rowIndex && this.focusedCell.colId === colId) return;
    this.focusedCell = { rowIndex, colId };
    this.cdr.markForCheck();
    this.cellFocused.emit({ api: this.api, rowIndex, column: this.cols.getColumn(colId), type: 'cellFocused' });
  }

  /** Tab-into-grid (AG: tabbing in focuses the grid; last focused cell is restored). A recent
   *  pointerdown means this focus came from a click — the click handlers own focus then.
   *  Runs OUTSIDE Angular (registered in ngAfterViewInit); re-enters the zone only when it
   *  actually changes focus state. */
  private lastPointerDownTs = 0;
  private rootPointerDownHandler?: () => void;
  private rootFocusHandler?: (ev: FocusEvent) => void;
  private onRootFocus(ev: FocusEvent): void {
    if (!this.isBrowser || ev.target !== this.rootRef?.nativeElement) return;
    if (Date.now() - this.lastPointerDownTs < 500) return;
    if (this.focusedCell || this.focusedHeaderColId) return;   // restore last focus position
    // AG: "when tabbing into the grid, the first column header will be focused."
    const first = this.allVisibleColumns[0];
    if (first) this.zone.run(() => this.setHeaderFocus(first.colId));
  }

  /** public wrapper so GridApi-driven scrolls recompute the window in-zone. */
  onScrollPublic(): void { this.recomputeWindow(); this.cdr.markForCheck(); }

  // ---- ARIA (AG accessibility parity: role=grid/row/gridcell/columnheader + indices) ----
  // Counting scheme: the header row is ARIA row 1, data rows follow (pivot/floating-filter
  // rows carry no row role, so they stay out of the count and indices remain consistent).
  get ariaRowCount(): number { return 1 + this.totalRowCount; }
  get ariaColCount(): number { return this.allVisibleColumns.length; }
  ariaRowIndex(node: RowNode): number { return node.rowIndex + 2; }
  ariaColIndex(col: Column): number { return this.allVisibleColumns.indexOf(col) + 1; }
  ariaSort(col: Column): string | null {
    if (!col.isSortable()) return null;
    return col.sort === 'asc' ? 'ascending' : col.sort === 'desc' ? 'descending' : 'none';
  }
  ariaSelected(node: RowNode): boolean | null {
    return this.rowSelection ? this.isSelected(node) : null;
  }
}

export function clampWidth(v: number, min: number, max: number | null): number {
  v = Math.max(v, min ?? 0);
  if (max != null) v = Math.min(v, max);
  return v;
}

function cap(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Frozen operator option lists for the Filters tool panel (stable identity — see toolOps).
const TOOL_TEXT_OPS: { value: string; label: string }[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'notContains', label: 'Not contains' },
  { value: 'equals', label: 'Equals' },
  { value: 'notEqual', label: 'Not equal' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'endsWith', label: 'Ends with' },
];
const TOOL_NUMBER_OPS: { value: string; label: string }[] = [
  { value: 'equals', label: 'Equals' },
  { value: 'notEqual', label: 'Not equal' },
  { value: 'greaterThan', label: 'Greater than' },
  { value: 'greaterThanOrEqual', label: 'Greater than or =' },
  { value: 'lessThan', label: 'Less than' },
  { value: 'lessThanOrEqual', label: 'Less than or =' },
  { value: 'inRange', label: 'In range' },
];
const TOOL_DATE_OPS: { value: string; label: string }[] = [
  { value: 'equals', label: 'Equals' },
  { value: 'lessThan', label: 'Before' },
  { value: 'greaterThan', label: 'After' },
  { value: 'inRange', label: 'In range' },
];

export interface MenuItem {
  label?: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  keepOpen?: boolean;
  submenu?: MenuItem[];
  action?: () => void;
}

/** Parse spreadsheet clipboard text (TSV). Handles CRLF/LF, the trailing newline Excel and
 *  Sheets append, and quoted cells containing tabs, newlines or doubled quotes. */
export function parseClipboardTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { quoted = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i++; continue; }
    if (ch === '\t') { row.push(cell); cell = ''; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
