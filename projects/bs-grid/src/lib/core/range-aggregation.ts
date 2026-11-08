/** Port of AG's `AggregationComp.onCellSelectionChanged` (ag-grid-enterprise
 *  statusBar/providedPanels/aggregationComp.ts) — the status-bar aggregation over a cell
 *  selection. AG counts EVERY non-empty cell whatever its type, and computes sum/min/max/avg
 *  over the numeric subset only; `count` is displayed when count > 1, the rest when
 *  numericCount > 1. Bigint values are folded into the number path (AG keeps a parallel
 *  bigint accumulator for values beyond MAX_SAFE_INTEGER; BsGrid cell values are never bigint). */
export interface RangeAggregation {
  count: number;
  numericCount: number;
  sum: number;
  avg: number;
  min: number;
  max: number;
}

export function computeRangeAggregation(values: Iterable<any>): RangeAggregation {
  let count = 0;
  let numericCount = 0;
  let sum = 0;
  let min: number | null = null;
  let max: number | null = null;

  for (let value of values) {
    // empty cell: skipped entirely, doesn't impact count (AG: `_missing(value) || value === ''`)
    if (value == null || value === '') continue;

    count++;

    // wrapped value, as produced by AG's count()/avg() agg funcs
    if (typeof value === 'object' && 'value' in value) {
      value = value.value;
      if (value === '') continue;
    }

    if (typeof value === 'bigint') value = Number(value);

    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed === '') continue;
      const asNumber = Number(trimmed);
      if (!Number.isFinite(asNumber)) continue;
      value = asNumber;
    }

    if (typeof value !== 'number' || isNaN(value)) continue;

    sum += value;
    if (min === null || value < min) min = value;
    if (max === null || value > max) max = value;
    numericCount++;
  }

  return { count, numericCount, sum, avg: sum / numericCount, min: min ?? 0, max: max ?? 0 };
}
