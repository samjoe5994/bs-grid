/**
 * Office Open XML (.xlsx) builders for BsGrid's Excel export, modelled on AG Grid v35's Excel
 * serializer. Pure string building — no DOM — so it is SSR-safe and unit-testable.
 */

/** AG Grid ExcelDataType names plus their OOXML short forms. */
export type ExcelDataType = 'String' | 'Number' | 'Boolean' | 'Formula' | 's' | 'n' | 'b' | 'f';

export interface ExcelCell {
  data?: { type?: ExcelDataType; value: string | number | boolean | null | undefined };
  /** Number of extra columns this cell spans to the right. */
  mergeAcross?: number;
}

export interface ExcelRow {
  cells: ExcelCell[];
  height?: number;
  outlineLevel?: number;
  collapsed?: boolean;
  hidden?: boolean;
}

export interface ExcelSheetConfig {
  rows: ExcelRow[];
  /** Column widths in px (converted with AG Grid's px -> character-unit formula). */
  columnWidths: number[];
  frozenRowCount?: number;
  frozenColumnCount?: number;
  rightToLeft?: boolean;
}

export interface ExcelWorkbookConfig {
  author?: string;
  fontSize?: number;
  activeSheetIndex?: number;
}

/**
 * Defaults used when an export call doesn't set the matching param. They mirror AG Grid v35 so
 * migrated screens export identically; change them here when BsGrid ships as its own package
 * (e.g. a 'Sheet1' sheet name).
 */
export const EXCEL_EXPORT_DEFAULTS = {
  sheetName: 'ag-grid',
  author: 'BsGrid',
  fontSize: 11,
  /** px; a narrower grid column still exports at least this wide. */
  minColumnWidth: 75,
} as const;

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Excel rejects (repairs) a file with a cell longer than this. */
const MAX_CELL_CHARS = 32767;
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Worksheet XML for one sheet (what api.getSheetDataForExcel returns). */
export function buildSheetXml(sheet: ExcelSheetConfig): string {
  const merges: string[] = [];
  let maxOutline = 0;
  const rowsXml = sheet.rows.map((row, i) => {
    const r = i + 1;
    let col = 0;
    const cells = row.cells.map(cell => {
      const ref = `${colLetter(col)}${r}`;
      if (cell.mergeAcross) merges.push(`${ref}:${colLetter(col + cell.mergeAcross)}${r}`);
      col += 1 + (cell.mergeAcross || 0);
      return cellXml(ref, cell.data?.value, cell.data?.type);
    }).join('');
    const outline = Math.min(Math.max(row.outlineLevel || 0, 0), 7);
    maxOutline = Math.max(maxOutline, outline);
    const attrs = (row.height != null ? ` ht="${row.height}" customHeight="1"` : '')
      + (outline ? ` outlineLevel="${outline}"` : '')
      + (row.collapsed ? ' collapsed="1"' : '')
      + (row.hidden ? ' hidden="1"' : '');
    return `<row r="${r}"${attrs}>${cells}</row>`;
  }).join('');

  const xSplit = sheet.frozenColumnCount || 0;
  const ySplit = sheet.frozenRowCount || 0;
  const pane = xSplit || ySplit
    ? `<pane${xSplit ? ` xSplit="${xSplit}"` : ''}${ySplit ? ` ySplit="${ySplit}"` : ''} topLeftCell="${colLetter(xSplit)}${ySplit + 1}" activePane="${xSplit && ySplit ? 'bottomRight' : xSplit ? 'topRight' : 'bottomLeft'}" state="frozen"/>`
    : '';
  const cols = sheet.columnWidths.length
    ? '<cols>' + sheet.columnWidths.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${excelColumnWidth(w)}" customWidth="1"/>`).join('') + '</cols>'
    : '';
  const mergeXml = merges.length
    ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
    : '';
  // Child order is mandated by the OOXML schema: sheetPr, sheetViews, sheetFormatPr, cols, sheetData, mergeCells.
  return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
    + '<sheetPr><outlinePr summaryBelow="0"/></sheetPr>'
    + `<sheetViews><sheetView rightToLeft="${sheet.rightToLeft ? 1 : 0}" workbookViewId="0">${pane}</sheetView></sheetViews>`
    + `<sheetFormatPr defaultRowHeight="15"${maxOutline ? ` outlineLevelRow="${maxOutline}"` : ''}/>`
    + `${cols}<sheetData>${rowsXml}</sheetData>${mergeXml}</worksheet>`;
}

/** All package parts for a workbook made of the given worksheet XML strings. */
export function buildWorkbookParts(sheets: { name: string; xml: string }[], cfg: ExcelWorkbookConfig = {}): Record<string, string> {
  const names = uniqueSheetNames(sheets.map(s => s.name));
  const active = Math.max(Math.min(cfg.activeSheetIndex ?? 0, sheets.length - 1), 0);
  const now = new Date().toISOString();
  const parts: Record<string, string> = {
    '[Content_Types].xml': `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
      + '</Types>',
    '_rels/.rels': `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
      + `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>`
      + `<Relationship Id="rId2" Type="${NS_PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/>`
      + '</Relationships>',
    'docProps/core.xml': `${XML_HEAD}<cp:coreProperties xmlns:cp="${NS_PKG_REL.replace('relationships', 'metadata/core-properties')}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
      + `<dc:creator>${escapeXml(cfg.author ?? EXCEL_EXPORT_DEFAULTS.author)}</dc:creator><dc:title>Workbook</dc:title>`
      + `<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>`
      + '</cp:coreProperties>',
    'xl/workbook.xml': `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`
      + `<bookViews><workbookView activeTab="${active}"/></bookViews><sheets>`
      + names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')
      + '</sheets></workbook>',
    'xl/_rels/workbook.xml.rels': `${XML_HEAD}<Relationships xmlns="${NS_PKG_REL}">`
      + sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')
      + `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>`
      + '</Relationships>',
    'xl/styles.xml': `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}">`
      + `<fonts count="1"><font><sz val="${cfg.fontSize ?? EXCEL_EXPORT_DEFAULTS.fontSize}"/><name val="Calibri"/></font></fonts>`
      + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
      + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>'
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>',
  };
  sheets.forEach((s, i) => (parts[`xl/worksheets/sheet${i + 1}.xml`] = s.xml));
  return parts;
}

/** Cell type for a grid body value — AG Grid's isNumerical, plus a guard so only plain decimal
 *  literals become number cells (AG would emit hex like "0x1A" as an invalid <v>). */
export function bodyCellType(value: unknown): 'n' | 's' {
  if (typeof value === 'bigint' || value == null) return 's';
  const isNumerical = isFinite(value as any) && value !== '' && !isNaN(parseFloat(value as any));
  return isNumerical && /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(String(value).trim()) ? 'n' : 's';
}

function cellXml(ref: string, value: unknown, type: ExcelDataType | undefined): string {
  if (value == null) return '';
  switch (type) {
    case 'Number': case 'n': {
      const n = Number(typeof value === 'string' ? value.trim() : value);
      if (Number.isFinite(n)) return `<c r="${ref}"><v>${n}</v></c>`;
      break;
    }
    case 'Boolean': case 'b':
      return `<c r="${ref}" t="b"><v>${value === true || value === 'true' || value === 1 || value === '1' ? 1 : 0}</v></c>`;
    case 'Formula': case 'f':
      return `<c r="${ref}"><f>${escapeXml(String(value).replace(/^=/, ''))}</f></c>`;
  }
  const text = String(value);
  if (text === '') return '';
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text.substring(0, MAX_CELL_CHARS))}</t></is></c>`;
}

/** px -> Excel character units, AG Grid's getExcelCellWidth. */
function excelColumnWidth(px: number): number {
  return Math.ceil((px - 12) / 7 + 1);
}

/** Excel requires sheet names to be 1-31 chars, without : \ / ? * [ ], and unique (case-insensitive). */
function uniqueSheetNames(raw: string[]): string[] {
  const used = new Set<string>();
  return raw.map(name => {
    const base = (String(name ?? '').replace(/[:\\/?*[\]]/g, ' ').replace(/^'+|'+$/g, '').trim() || 'Sheet').substring(0, 31);
    let candidate = base;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      candidate = base.substring(0, 31 - suffix.length) + suffix;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

/** 0 -> A, 25 -> Z, 26 -> AA */
function colLetter(n: number): string {
  let s = '';
  for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function escapeXml(v: string): string {
  // Strip control chars XML 1.0 forbids (they make Excel reject the file), then escape.
  return String(v ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
