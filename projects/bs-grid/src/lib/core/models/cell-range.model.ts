/**
 * A rectangular cell range: display-index row bounds (inclusive, always start <= end) ×
 * an ordered list of colIds (the column axis has no meaningful "index" once columns can be
 * reordered/pinned/hidden, so the range carries the actual colIds it spans).
 */
export interface CellRange {
  startRowIndex: number;
  endRowIndex: number;
  columns: string[];
}
