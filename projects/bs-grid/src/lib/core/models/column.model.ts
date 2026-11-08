import { ColDef, SortDirection } from '../../api/public-types';

/**
 * Column — the single source of truth per column. Drives the header cell, body cells,
 * the header menu, the columns tool panel, and column-state serialization.
 * Built from a ColDef + defaultColDef merge by ColumnService.
 */
export class Column {
  colId: string;
  colDef: ColDef;

  width: number;
  minWidth: number;
  maxWidth: number | null;
  flex: number | null;

  /** cumulative left offset within its region (left | center | right); set by layout pass. */
  left = 0;

  pinned: 'left' | 'right' | null = null;
  hide = false;

  sort: SortDirection = null;
  sortIndex: number | null = null;

  rowGroup = false;
  rowGroupIndex: number | null = null;
  /** AG-compatible: built-in name ('count','sum',…) or a custom aggregation function. */
  aggFunc: string | Function | null = null;
  pivot = false;
  pivotIndex: number | null = null;

  moving = false;
  resizing = false;

  constructor(colId: string, colDef: ColDef) {
    this.colId = colId;
    this.colDef = colDef;
    this.width = colDef.width ?? 0;      // 0 => needs sizing (flex or default)
    this.minWidth = colDef.minWidth ?? 40;
    this.maxWidth = colDef.maxWidth ?? null;
    this.flex = colDef.flex ?? null;
    this.hide = colDef.hide ?? false;
    this.sort = colDef.sort ?? null;
    this.sortIndex = colDef.sortIndex ?? null;
    this.rowGroup = colDef.rowGroup ?? false;
    this.rowGroupIndex = colDef['rowGroupIndex'] ?? null;
    this.aggFunc = colDef.aggFunc ?? null;
    this.pivot = colDef['pivot'] ?? false;
    this.pivotIndex = colDef['pivotIndex'] ?? null;
    this.pinned = normalizePin(colDef.pinned);
  }

  get headerName(): string {
    return this.colDef.headerName ?? this.colDef.field ?? this.colId;
  }

  // ---- AG-Grid-compatible accessor API ----
  // Host callbacks (processCellForClipboard, getContextMenuItems, onCellDoubleClicked, …)
  // are written against AG's Column method surface. Expose the same methods so those
  // callbacks work unchanged when they receive a BsGrid Column.
  getColId(): string { return this.colId; }
  getId(): string { return this.colId; }
  getColDef(): ColDef { return this.colDef; }
  getUserProvidedColDef(): ColDef { return this.colDef; }
  getDefinition(): ColDef { return this.colDef; }
  getActualWidth(): number { return this.width; }
  getSort(): SortDirection { return this.sort; }
  isPinned(): boolean { return this.pinned != null; }
  isPinnedLeft(): boolean { return this.pinned === 'left'; }
  isPinnedRight(): boolean { return this.pinned === 'right'; }
  isRowGroupActive(): boolean { return this.rowGroup; }
  isVisible(): boolean { return !this.hide; }

  isSortable(): boolean {
    return this.colDef.sortable !== false;
  }

  isResizable(): boolean {
    return this.colDef.resizable !== false;
  }

  isMovable(): boolean {
    return !this.colDef.suppressMovable && !this.colDef.lockPosition;
  }

  isFilterable(): boolean {
    return this.colDef.filter !== false && this.colDef.filter != null
      ? true
      : this.colDef.filter !== false; // default true unless explicitly false
  }
}

export function normalizePin(pinned: any): 'left' | 'right' | null {
  if (pinned === true || pinned === 'left') return 'left';
  if (pinned === 'right') return 'right';
  return null;
}
