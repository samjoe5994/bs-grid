import { Injectable } from '@angular/core';
import { Column } from './models/column.model';
import { RowNode } from './models/row-node.model';
import { ValueService } from './value.service';

export interface SortModelItem { colId: string; sort: 'asc' | 'desc'; }

/**
 * SortService — maintains an ordered multi-column sort model and produces a stable
 * comparator that walks it, using each column's `comparator` if present else a
 * type-aware default (number subtract, date compare, locale string compare).
 * Sorting is pure and SSR-safe.
 */
@Injectable()
export class SortService {
  constructor(private valueService: ValueService) {}

  /** Advance a column through its sorting order on a header click. */
  cycleSort(column: Column, columns: Column[], additive: boolean): void {
    const order = column.colDef.sortingOrder ?? ['asc', 'desc', null];
    const idx = order.indexOf(column.sort);
    const next = order[(idx + 1) % order.length];

    if (!additive) {
      for (const c of columns) { if (c !== column) { c.sort = null; c.sortIndex = null; } }
    }
    column.sort = next as any;
    this.renumber(columns);
  }

  private renumber(columns: Column[]): void {
    const active = columns.filter(c => c.sort).sort(
      (a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0)
    );
    active.forEach((c, i) => (c.sortIndex = i));
    columns.filter(c => !c.sort).forEach(c => (c.sortIndex = null));
  }

  getSortModel(columns: Column[]): SortModelItem[] {
    return columns
      .filter(c => c.sort)
      .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
      .map(c => ({ colId: c.colId, sort: c.sort as 'asc' | 'desc' }));
  }

  /** Sort a node list in place against the active sort model. */
  applySort(nodes: RowNode[], columns: Column[]): void {
    const model = this.getSortModel(columns);
    if (!model.length) return;
    const cols = model.map(m => ({
      column: columns.find(c => c.colId === m.colId)!,
      dir: m.sort === 'asc' ? 1 : -1,
    })).filter(x => x.column);

    nodes.sort((na, nb) => {
      for (const { column, dir } of cols) {
        const va = this.valueService.getValue(column, na);
        const vb = this.valueService.getValue(column, nb);
        let cmp: number;
        if (column.colDef.comparator) {
          // A custom comparator that throws or returns NaN would corrupt the whole sort
          // (NaN leaves order undefined); treat either as "equal" and move to the next key.
          try {
            cmp = column.colDef.comparator(va, vb, na, nb, dir === -1);
            if (typeof cmp !== 'number' || Number.isNaN(cmp)) cmp = 0;
          } catch { cmp = 0; }
        } else {
          cmp = defaultCompare(va, vb);
        }
        if (cmp !== 0) return cmp * dir;
      }
      return 0;
    });
  }
}

export function defaultCompare(a: any, b: any): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb) && `${a}`.trim() !== '' && `${b}`.trim() !== '') return na - nb;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}
