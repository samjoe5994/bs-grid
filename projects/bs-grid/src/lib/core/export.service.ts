import { Inject, Injectable, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { AUTO_GROUP_COL_ID } from './column.service';
import { Column } from './models/column.model';
import { RowNode } from './models/row-node.model';
import { ValueService } from './value.service';
import { zipFiles, zipFilesSync } from './zip-writer';
import { EXCEL_EXPORT_DEFAULTS, ExcelRow, XLSX_MIME, bodyCellType, buildSheetXml, buildWorkbookParts } from './excel-xlsx';

type HeightParam = number | ((params: { rowIndex: number }) => number);

/** Export params — names and semantics follow AG Grid v35 (BaseExportParams / ExcelExportParams). */
export interface ExportParams {
  fileName?: string | (() => string);
  columnKeys?: (string | Column)[];
  allColumns?: boolean;
  onlySelected?: boolean;
  skipColumnHeaders?: boolean;
  /** Leave group / grand-total rows out of the export. */
  skipRowGroups?: boolean;
  shouldRowBeSkipped?: (params: { node: RowNode; api: any }) => boolean;
  processCellCallback?: (params: { value: any; node: RowNode; column: Column; api: any }) => any;
  processHeaderCallback?: (params: { column: Column }) => string;

  // ---- Excel only ----
  /** Worksheet name (max 31 chars); default EXCEL_EXPORT_DEFAULTS.sheetName. */
  sheetName?: string | (() => string);
  /** Column width in px (number or per-column fn); default is the grid's own width (min EXCEL_EXPORT_DEFAULTS.minColumnWidth). */
  columnWidth?: number | ((params: { column: Column; index: number }) => number);
  headerRowHeight?: HeightParam;
  rowHeight?: HeightParam;
  /** 'headers' freezes the header row(s) (plus any prependContent); a fn freezes each body row it returns true for. */
  freezeRows?: 'headers' | 'headersAndPinnedRows' | ((params: { node: RowNode }) => boolean);
  /** 'pinned' freezes the leading pinned columns; a fn freezes each leading column it returns true for. */
  freezeColumns?: 'pinned' | ((params: { column: Column }) => boolean);
  rightToLeft?: boolean;
  prependContent?: ExcelRow[];
  appendContent?: ExcelRow[];
  /** Group rows get an Excel outline level; 'collapsed' / 'match' also collapse them like AG Grid. */
  rowGroupExpandState?: 'expanded' | 'collapsed' | 'match';
  suppressRowOutline?: boolean;
  author?: string;
  fontSize?: number;
  mimeType?: string;
}

export interface ExcelMultipleSheetParams {
  /** Worksheet strings from getSheetDataForExcel(). */
  data: string[];
  fileName?: string | (() => string);
  author?: string;
  fontSize?: number;
  activeSheetIndex?: number;
  mimeType?: string;
}

/**
 * ExportService — CSV + Excel (.xlsx) export of the current display
 * list (filtered + sorted), honoring column selection, onlySelected, and a per-cell
 * process callback. Value resolution is pure; only the final file download touches the
 * DOM and is isPlatformBrowser-guarded.
 */
@Injectable()
export class ExportService {
  private readonly isBrowser: boolean;
  constructor(private values: ValueService, @Inject(PLATFORM_ID) platformId: Object) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  private resolveColumns(all: Column[], params: ExportParams): Column[] {
    if (params.columnKeys?.length) {
      return params.columnKeys.map(k => (typeof k === 'string' ? all.find(c => c.colId === k) : k)).filter(Boolean) as Column[];
    }
    // Skip UI-only columns (e.g. selection checkboxes) flagged suppressExport — they have no
    // data field and would emit a blank header + blank cells into CSV/Excel.
    return all.filter(c => !(c.colDef as any)?.suppressExport && (params.allColumns ? true : !c.hide));
  }

  private cellText(col: Column, node: RowNode, api: any, params: ExportParams): string {
    let value: any;
    if (node.group) {
      // Group / grand-total rows have no data object: the auto-group column exports the group
      // key (indented per level, mirroring the on-screen tree) and every other column exports
      // its aggregated value — exactly what the pivot/grouped grid displays.
      if (col.colId === AUTO_GROUP_COL_ID) {
        const label = node.key === '' ? '(Blanks)' : node.key ?? '';
        value = '  '.repeat(node.level) + label;
      } else {
        value = formatAggValue(node.aggData?.[col.colId]);
      }
    } else {
      value = this.values.getDisplayValue(col, node);
    }
    if (params.processCellCallback) {
      value = params.processCellCallback({ value, node, column: col, api });
    }
    return value == null ? '' : String(value);
  }

  /** Body nodes after AG Grid's row-level filters (skipRowGroups, shouldRowBeSkipped). */
  private exportableNodes(nodes: RowNode[], api: any, params: ExportParams): RowNode[] {
    if (!params.skipRowGroups && !params.shouldRowBeSkipped) return nodes;
    return nodes.filter(node => !(params.skipRowGroups && node.group)
      && !params.shouldRowBeSkipped?.({ node, api }));
  }

  private headerText(c: Column, params: ExportParams): string {
    return params.processHeaderCallback ? params.processHeaderCallback({ column: c }) : (c.headerName ?? '');
  }

  buildRows(columns: Column[], nodes: RowNode[], api: any, params: ExportParams): string[][] {
    const cols = this.resolveColumns(columns, params);
    const out: string[][] = [];
    if (!params.skipColumnHeaders) out.push(cols.map(c => this.headerText(c, params)));
    for (const node of this.exportableNodes(nodes, api, params)) out.push(cols.map(c => this.cellText(c, node, api, params)));
    return out;
  }

  /** Build CSV text without downloading (backs api.getDataAsCsv). */
  buildCsvString(columns: Column[], nodes: RowNode[], api: any, params: ExportParams = {}): string {
    const rows = this.buildRows(columns, nodes, api, params);
    return rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  }

  exportCsv(columns: Column[], nodes: RowNode[], api: any, params: ExportParams = {}): string {
    const csv = this.buildCsvString(columns, nodes, api, params);
    this.download(resolveFileName(params.fileName, '.csv'), csv, 'text/csv;charset=utf-8;');
    return csv;
  }

  /**
   * Worksheet XML for the grid (AG Grid's getSheetDataForExcel). Header cells are always text;
   * body values that are numeric become number cells; rows carry outline levels for groups.
   */
  getSheetDataForExcel(columns: Column[], nodes: RowNode[], api: any, params: ExportParams = {}): string {
    const cols = this.resolveColumns(columns, params);
    const rows: ExcelRow[] = [];
    const height = (h: HeightParam | undefined) => (typeof h === 'function' ? h({ rowIndex: rows.length + 1 }) : h);
    let frozenRows = 0;

    for (const row of params.prependContent ?? []) rows.push({ ...row, height: row.height ?? height(params.rowHeight) });
    if (!params.skipColumnHeaders) {
      rows.push({
        cells: cols.map(c => ({ data: { type: 's', value: this.headerText(c, params) } })),
        height: height(params.headerRowHeight),
      });
    }
    if (params.freezeRows === 'headers' || params.freezeRows === 'headersAndPinnedRows') frozenRows = rows.length;

    // Outline depth from the depth-first export order: a group row sits at its own level, rows
    // below it one deeper (BsGrid leaf nodes don't carry their depth). AG caps outlines at 7.
    const expandState = params.rowGroupExpandState ?? 'expanded';
    const openStack: boolean[] = [];   // expanded flag per enclosing group level
    for (const node of this.exportableNodes(nodes, api, params)) {
      let depth = 0;
      if (node.group && node.groupPath !== '__grandTotal__') {
        depth = node.level;
        openStack.length = depth;
      } else if (!node.group) {
        depth = openStack.length;
      } else {
        openStack.length = 0;
      }
      const hidden = expandState === 'collapsed' ? depth > 0 : expandState === 'match' && openStack.some(open => !open);
      const row: ExcelRow = {
        cells: cols.map(c => {
          const value = this.cellText(c, node, api, params);
          return { data: { type: bodyCellType(value), value } };
        }),
        height: height(params.rowHeight),
        outlineLevel: params.suppressRowOutline ? 0 : depth,
        hidden: !params.suppressRowOutline && hidden,
      };
      if (node.group && node.groupPath !== '__grandTotal__') {
        const open = expandState === 'expanded' || (expandState === 'match' && !!node.expanded);
        row.collapsed = !params.suppressRowOutline && !open && !!node.children?.length;
        openStack[depth] = open;
      }
      if (typeof params.freezeRows === 'function' && params.freezeRows({ node })) frozenRows++;
      rows.push(row);
    }
    for (const row of params.appendContent ?? []) rows.push({ ...row, height: row.height ?? height(params.rowHeight) });

    let frozenCols = 0;
    const { freezeColumns, rightToLeft, columnWidth } = params;
    for (const column of cols) {
      const freeze = freezeColumns === 'pinned'
        ? column.pinned === (rightToLeft ? 'right' : 'left')
        : typeof freezeColumns === 'function' && freezeColumns({ column });
      if (!freeze) break;
      frozenCols++;
    }

    const xml = buildSheetXml({
      rows,
      // AG Grid: explicit columnWidth wins, else the column's on-screen width (with a minimum).
      columnWidths: cols.map((column, index) =>
        typeof columnWidth === 'number' ? columnWidth
          : columnWidth ? columnWidth({ column, index })
          : Math.max(column.getActualWidth(), EXCEL_EXPORT_DEFAULTS.minColumnWidth)),
      frozenRowCount: frozenRows,
      frozenColumnCount: frozenCols,
      rightToLeft,
    });
    const name = typeof params.sheetName === 'function' ? params.sheetName() : params.sheetName;
    // Identical sheet data can be requested twice under different names, so queue names per string.
    const queued = this.sheetNames.get(xml) ?? [];
    queued.push(name != null ? String(name).substring(0, 31) : EXCEL_EXPORT_DEFAULTS.sheetName);
    this.sheetNames.set(xml, queued);
    return xml;
  }

  /** Uncompressed .xlsx Blob, synchronously (AG Grid's getDataAsExcel). */
  getDataAsExcel(columns: Column[], nodes: RowNode[], api: any, params: ExportParams = {}): Blob {
    return this.getMultipleSheetsAsExcel({ ...params, fileName: undefined, data: [this.getSheetDataForExcel(columns, nodes, api, params)] })!;
  }

  /**
   * Real Office Open XML (.xlsx) download, deflate-compressed. Replaces the old HTML-table-as-.xls
   * shortcut, which Excel saved as a "web page" (spawning an _files folder) and Numbers / Google
   * Sheets showed as raw HTML.
   */
  exportExcel(columns: Column[], nodes: RowNode[], api: any, params: ExportParams = {}): void {
    if (!this.isBrowser) return;
    this.exportMultipleSheetsAsExcel({ ...params, data: [this.getSheetDataForExcel(columns, nodes, api, params)] });
  }

  /** Uncompressed multi-sheet workbook from getSheetDataForExcel() strings (AG Grid's getMultipleSheetsAsExcel). */
  getMultipleSheetsAsExcel(params: ExcelMultipleSheetParams): Blob | undefined {
    const parts = this.workbookParts(params);
    return parts && zipFilesSync(parts, params.mimeType || XLSX_MIME);
  }

  /** Compressed multi-sheet workbook download (AG Grid's exportMultipleSheetsAsExcel). */
  exportMultipleSheetsAsExcel(params: ExcelMultipleSheetParams): void {
    if (!this.isBrowser) return;
    const parts = this.workbookParts(params);
    if (!parts) return;
    const fileName = resolveFileName(params.fileName, '.xlsx');
    zipFiles(parts, params.mimeType || XLSX_MIME)
      .then(blob => this.downloadBlob(fileName, blob))
      .catch(err => console.error('Excel export failed', err));
  }

  /** Sheet names for worksheet strings handed out by getSheetDataForExcel; cleared once a workbook is built. */
  private sheetNames = new Map<string, string[]>();

  private workbookParts(params: ExcelMultipleSheetParams): Record<string, string> | undefined {
    if (!params.data?.length) {
      console.warn('BsGrid: Excel export needs at least one sheet in params.data');
      return undefined;
    }
    const sheets = params.data.map(xml => ({ xml, name: this.sheetNames.get(xml)?.shift() ?? EXCEL_EXPORT_DEFAULTS.sheetName }));
    this.sheetNames.clear();
    return buildWorkbookParts(sheets, params);
  }

  private download(fileName: string, content: string, mime: string): void {
    if (!this.isBrowser) return;
    this.downloadBlob(fileName, new Blob([content], { type: mime }));
  }

  private downloadBlob(fileName: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Match the grid's group-cell display: whole numbers plain, other numbers to 2 decimals. */
function formatAggValue(v: any): string {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

// Cell values are written verbatim, matching AG Grid: quote only when the value contains a
// quote/comma/newline, and escape inner quotes by doubling. No formula-prefix guard — AG Grid
// applied none, and adding one turned exported phone numbers into '+91 70000 00989.
function csvCell(v: string): string {
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function resolveFileName(fileName: string | (() => string) | undefined, ext: string): string {
  const name = (typeof fileName === 'function' ? fileName() : fileName) || 'export';
  return name.toLowerCase().endsWith(ext) ? name : name + ext;
}
