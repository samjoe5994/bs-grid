/**
 * BsGrid public types — intentionally AG-Grid-shaped so existing `columnDefs`,
 * `defaultColDef`, `gridOptions` and event handlers pass through unchanged when a
 * `<ag-grid-angular>` is swapped for `<bs-grid>`. Only the props BlockSurvey actually
 * uses are modeled (see docs/bs-grid/RESEARCH.md Part E). Unknown props are tolerated
 * (index signature) so no colDef needs editing during migration.
 */

export type Pinned = 'left' | 'right' | null | boolean;
export type SortDirection = 'asc' | 'desc' | null;

/** Params object handed to value functions / renderers / editors (AG-shaped subset). */
export interface BsCellParams<TData = any> {
  value: any;
  valueFormatted?: string | null;
  data: TData;
  node: any;              // RowNode (kept `any` here to avoid a cycle with core/models)
  colDef: ColDef;
  column: any;            // Column
  rowIndex: number;
  api: any;               // GridApi
  context?: any;
  getValue?: (field: string) => any;
  setValue?: (value: any) => void;
  [key: string]: any;
}

export interface ColDef<TData = any> {
  colId?: string;
  field?: string;
  headerName?: string;
  headerTooltip?: string;

  // sizing
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  flex?: number;
  resizable?: boolean;
  suppressSizeToFit?: boolean;
  suppressAutoSize?: boolean;

  // placement
  pinned?: Pinned;
  lockPinned?: boolean;
  lockPosition?: 'left' | 'right' | boolean;
  suppressMovable?: boolean;
  hide?: boolean;

  // sort
  sortable?: boolean;
  sort?: SortDirection;
  sortIndex?: number | null;
  sortingOrder?: SortDirection[];
  comparator?: (a: any, b: any, nodeA?: any, nodeB?: any, isDescending?: boolean) => number;

  // filter
  filter?: boolean | string | any;
  filterParams?: any;
  floatingFilter?: boolean;
  filterValueGetter?: (params: BsCellParams<TData>) => any;

  // value pipeline
  valueGetter?: string | ((params: BsCellParams<TData>) => any);
  valueFormatter?: string | ((params: BsCellParams<TData>) => string);
  valueParser?: string | ((params: BsCellParams<TData>) => any);
  valueSetter?: string | ((params: BsCellParams<TData>) => boolean);

  // rendering / editing
  cellRenderer?: any;
  cellRendererParams?: any;
  cellRendererSelector?: (params: BsCellParams<TData>) => { component: any; params?: any } | undefined;
  cellEditor?: any;
  cellEditorParams?: any;
  cellEditorPopup?: boolean;
  cellEditorPopupPosition?: 'over' | 'under';
  cellEditorSelector?: (params: BsCellParams<TData>) => { component: any; params?: any } | undefined;
  editable?: boolean | ((params: BsCellParams<TData>) => boolean);
  /** AG: return true to keep a key inside the cell / its editor instead of the grid acting on it. */
  suppressKeyboardEvent?: (params: { event: KeyboardEvent; editing: boolean; node: any; column: any; colDef: ColDef<TData>; api: any; data: TData }) => boolean;

  // styling
  cellStyle?: any;
  cellClass?: string | string[] | ((params: BsCellParams<TData>) => string | string[]);
  cellClassRules?: Record<string, string | ((params: BsCellParams<TData>) => boolean)>;
  tooltipField?: string;
  tooltipValueGetter?: (params: BsCellParams<TData>) => string;

  // selection helpers injected onto a column (AG-compatible names)
  checkboxSelection?: boolean | ((params: any) => boolean);
  headerCheckboxSelection?: boolean;
  headerCheckboxSelectionFilteredOnly?: boolean;
  showDisabledCheckboxes?: boolean;

  // grouping / values (tool panel enablement)
  enableRowGroup?: boolean;
  enablePivot?: boolean;
  enableValue?: boolean;
  rowGroup?: boolean;
  rowGroupIndex?: number | null;
  pivot?: boolean;
  pivotIndex?: number | null;
  /** built-in name ('count','sum','avg',…) or an AG-style custom aggregation function. */
  aggFunc?: string | Function | null;
  allowedAggFuncs?: string[];

  // misc
  autoHeight?: boolean;
  wrapText?: boolean;
  cellDataType?: boolean | string;
  chartDataType?: string;

  [key: string]: any;
}

export interface SideBarDef {
  toolPanels?: Array<{
    id: string;
    labelDefault?: string;
    labelKey?: string;
    iconKey?: string;
    toolPanel: string;
    toolPanelParams?: any;
  }>;
  defaultToolPanel?: string;
}

export interface StatusBarDef {
  statusPanels?: Array<{ statusPanel: string; align?: 'left' | 'center' | 'right'; statusPanelParams?: any }>;
}

export interface GridOptions<TData = any> {
  columnDefs?: ColDef<TData>[];
  defaultColDef?: ColDef<TData>;
  rowData?: TData[];
  rowModelType?: 'clientSide' | 'infinite';
  getRowId?: (params: { data: TData }) => string;
  rowSelection?: 'single' | 'multiple' | any;
  suppressRowClickSelection?: boolean;
  isRowSelectable?: (node: any) => boolean;
  singleClickEdit?: boolean;
  stopEditingWhenCellsLoseFocus?: boolean;
  /** After Enter commits an edit, move focus down one cell (AG v31+ name). */
  enterNavigatesVerticallyAfterEdit?: boolean;
  /** AG ≤v30 name for enterNavigatesVerticallyAfterEdit. */
  enterMovesDownAfterEdit?: boolean;
  rowHeight?: number;
  headerHeight?: number;
  floatingFiltersHeight?: number;
  pagination?: boolean;
  paginationPageSize?: number;
  paginationAutoPageSize?: boolean;
  processUnpinnedColumns?: (params: { columns: any[]; viewportWidth: number; api: any }) => any[];
  paginationPageSizeSelector?: boolean | number[];
  suppressPaginationPanel?: boolean;
  sideBar?: SideBarDef | string | string[] | boolean;
  statusBar?: StatusBarDef;
  valueCache?: boolean;
  popupParent?: any;
  overlayLoadingTemplate?: string;
  [key: string]: any;
}

// ---- Event payloads (AG-shaped subset) ----
export interface GridReadyEvent { api: any; type: 'gridReady'; }
export interface FirstDataRenderedEvent { api: any; type: 'firstDataRendered'; }
export interface SelectionChangedEvent { api: any; source?: string; type: 'selectionChanged'; }
export interface RowEvent { api: any; node: any; data: any; rowIndex: number; event?: Event; type: string; }
export interface CellEvent extends RowEvent { column: any; colDef: ColDef; value: any; }
export interface CellValueChangedEvent extends CellEvent { oldValue: any; newValue: any; }
export interface FilterChangedEvent { api: any; type: 'filterChanged'; }
export interface PaginationChangedEvent {
  api: any; type: 'paginationChanged';
  animate: boolean; newData: boolean; newPage: boolean; newPageSize: boolean; keepRenderedRows: boolean;
}
export interface ColumnEvent { api: any; type: string; column?: any; columns?: any[]; pinned?: 'left' | 'right' | null; source?: string; }

// ---- AG-compatible cell-component contracts (duck-typed by BsCellComponent) ----
// BsGrid mounts custom cell renderers/editors as Angular components and drives them through
// the same lifecycle AG Grid uses: agInit + refresh for renderers; agInit + getValue (+ the
// optional hooks) for editors. Declaring these here lets BlockSurvey's existing renderer/editor
// components keep `implements ICellRendererAngularComp` / `ICellEditorAngularComp` without
// importing anything from the ag-grid-* packages. Params are intentionally loose (`any`).
export interface ICellRendererAngularComp {
  agInit(params: any): void;
  /** Return true to keep the existing instance on refresh, false to have the cell re-render. */
  refresh(params?: any): boolean;
  afterGuiAttached?(): void;
  destroy?(): void;
}

export interface ICellEditorAngularComp {
  agInit(params: any): void;
  /** The committed value; flows through valueSetter -> cellValueChanged. */
  getValue(): any;
  afterGuiAttached?(): void;
  isPopup?(): boolean;
  getPopupPosition?(): 'over' | 'under';
  isCancelBeforeStart?(): boolean;
  isCancelAfterEnd?(): boolean;
  focusIn?(): void;
  focusOut?(): void;
}

// Params object handed to a cell editor's agInit(). Mirrors the AG fields BlockSurvey editors
// use; the index signature keeps host-specific extras (e.g. questionId, options) type-safe.
export interface ICellEditorParams<TData = any, TValue = any> {
  value: TValue;
  data: TData;
  node: any;
  column: any;
  colDef: ColDef<TData>;
  api: any;
  context?: any;
  /** Ends editing; commits unless isCancel* returns true. */
  stopEditing: (suppressNavigateAfterEdit?: boolean) => void;
  eGridCell?: HTMLElement;
  cellStartedEdit?: boolean;
  [key: string]: any;
}
