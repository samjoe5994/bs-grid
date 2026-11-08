import { Column } from '../core/models/column.model';
import { RowNode } from '../core/models/row-node.model';

/**
 * Pure windowing math for the virtualization engine (SPEC.md B.3). No DOM, no browser
 * APIs — fully SSR-safe and unit-testable. The engine component feeds it scroll offsets
 * and viewport sizes and renders only the returned index ranges.
 */

export const DEFAULT_ROW_BUFFER = 10;
export const MAX_RENDERED_ROWS = 500;

export interface RowWindow {
  firstRow: number;
  lastRow: number;   // inclusive
}

export interface ColWindow {
  firstCol: number;
  lastCol: number;   // inclusive
}

/**
 * Build a prefix-sum array of row tops for variable heights. `tops[i]` = y offset of row
 * i; `tops[count]` = total height. For uniform heights callers can skip this and multiply.
 */
export function buildRowTops(nodes: RowNode[], defaultHeight: number): number[] {
  const tops = new Array(nodes.length + 1);
  let y = 0;
  for (let i = 0; i < nodes.length; i++) {
    tops[i] = y;
    const h = nodes[i].rowHeight || defaultHeight;
    nodes[i].rowTop = y;
    y += h;
  }
  tops[nodes.length] = y;
  return tops;
}

/** Total content height from a tops array (or uniform math). */
export function totalHeight(rowCount: number, rowHeight: number, tops?: number[]): number {
  if (tops && tops.length) return tops[tops.length - 1];
  return rowCount * rowHeight;
}

/**
 * Compute the visible row window given uniform row height. Adds a buffer above/below and
 * clamps to [0,count) and the MAX_RENDERED_ROWS cap.
 */
export function computeRowWindow(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
  rowHeight: number,
  buffer = DEFAULT_ROW_BUFFER,
): RowWindow {
  if (rowCount === 0 || rowHeight <= 0) return { firstRow: 0, lastRow: -1 };
  let first = Math.floor(scrollTop / rowHeight) - buffer;
  let last = Math.ceil((scrollTop + viewportHeight) / rowHeight) + buffer;
  first = Math.max(0, first);
  last = Math.min(rowCount - 1, last);
  if (last - first + 1 > MAX_RENDERED_ROWS) last = first + MAX_RENDERED_ROWS - 1;
  return { firstRow: first, lastRow: last };
}

/**
 * Variable-height row window via binary search over a tops prefix-sum array.
 */
export function computeRowWindowVariable(
  scrollTop: number,
  viewportHeight: number,
  tops: number[],
  buffer = DEFAULT_ROW_BUFFER,
): RowWindow {
  const count = tops.length - 1;
  if (count <= 0) return { firstRow: 0, lastRow: -1 };
  let first = upperBound(tops, scrollTop) - 1 - buffer;
  let last = upperBound(tops, scrollTop + viewportHeight) + buffer;
  first = Math.max(0, first);
  last = Math.min(count - 1, last);
  if (last - first + 1 > MAX_RENDERED_ROWS) last = first + MAX_RENDERED_ROWS - 1;
  return { firstRow: first, lastRow: last };
}

/**
 * Column window for the center (scrollable) region. Pinned columns are always rendered
 * (handled by the engine separately). No horizontal buffer — AG Grid renders only visible
 * center columns. `lefts[i]` is the left offset of center column i; `lefts[count]` = width.
 */
export function computeColWindow(
  scrollLeft: number,
  viewportWidth: number,
  centerColumns: Column[],
): ColWindow {
  const n = centerColumns.length;
  if (n === 0) return { firstCol: 0, lastCol: -1 };
  const lefts = new Array(n + 1);
  let x = 0;
  for (let i = 0; i < n; i++) { lefts[i] = x; x += centerColumns[i].width || 0; }
  lefts[n] = x;
  return computeColWindowFromLefts(scrollLeft, viewportWidth, lefts);
}

/**
 * Same window as computeColWindow but over a PRECOMPUTED prefix-sum array (`lefts[i]` = left
 * offset of center column i; `lefts[n]` = total center width). The grid caches this array on
 * ColumnService and rebuilds it only when column widths change, so scrolling no longer allocates
 * an O(columns) array every frame — the two binary searches below are the entire per-scroll cost.
 */
export function computeColWindowFromLefts(
  scrollLeft: number,
  viewportWidth: number,
  lefts: number[],
): ColWindow {
  const n = (lefts?.length ?? 0) - 1;
  if (n <= 0) return { firstCol: 0, lastCol: -1 };
  let first = upperBound(lefts, scrollLeft) - 1;
  let last = upperBound(lefts, scrollLeft + viewportWidth);
  first = Math.max(0, first);
  last = Math.min(n - 1, last);
  return { firstCol: first, lastCol: last };
}

/** first index i where arr[i] > target (arr sorted ascending). */
function upperBound(arr: number[], target: number): number {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
