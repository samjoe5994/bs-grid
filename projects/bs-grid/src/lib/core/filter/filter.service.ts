import { Injectable } from '@angular/core';
import { Column } from '../models/column.model';
import { RowNode } from '../models/row-node.model';
import { ValueService } from '../value.service';

export type FilterType = 'text' | 'number' | 'date' | 'set' | 'multi';

export interface ColumnFilterModel {
  filterType: FilterType;
  /** text/number: the search/compare value. */
  type?: string;        // e.g. 'contains' | 'equals' | 'startsWith' | 'greaterThan' | 'lessThan'
  filter?: any;
  filterTo?: any;
  /** set: the selected values. */
  values?: any[];
  dateFrom?: string;
  dateTo?: string;
  /** multi (agMultiColumnFilter): AND of sub-filters. */
  filters?: ColumnFilterModel[];
}

/**
 * FilterService — maintains the per-column filter model + a global quick filter, and
 * answers doesFilterPass(node) by AND-combining all active predicates against each
 * column's value (honoring filterValueGetter). Model shapes mirror AG Grid so
 * getFilterModel()/setFilterModel() round-trip with existing persistence code.
 *
 * Phase 5 ships text/number/date/set predicates driven by the floating-filter row; typed
 * filter popups (set checkboxes, number ranges) layer on later behind the same model.
 */
@Injectable()
export class FilterService {
  private model: Record<string, ColumnFilterModel> = {};
  private quickFilter = '';

  /** grid-level external filter hooks (crosstab uses these). */
  isExternalFilterPresent?: () => boolean;
  doesExternalFilterPass?: (node: RowNode) => boolean;

  constructor(private values: ValueService) {}

  // ---- model ----
  getModel(): Record<string, ColumnFilterModel> {
    return JSON.parse(JSON.stringify(this.model));
  }

  setModel(model: Record<string, ColumnFilterModel> | null): void {
    this.model = model ? JSON.parse(JSON.stringify(model)) : {};
  }

  getColumnModel(colId: string): ColumnFilterModel | undefined { return this.model[colId]; }

  setColumnFilter(colId: string, m: ColumnFilterModel | null): void {
    if (m == null || this.isEmptyModel(m)) {
      delete this.model[colId];
    } else {
      this.model[colId] = m;
    }
  }

  /** true if a model carries no active constraint (varies by filter type). */
  private isEmptyModel(m: ColumnFilterModel): boolean {
    switch (m.filterType) {
      case 'multi': return !(m.filters || []).some(sub => !this.isEmptyModel(sub));
      // An explicit empty selection (values: []) is an ACTIVE "exclude everything" filter that
      // shows 0 rows (matching AG Grid). Only a missing values array means "no set filter" — so
      // deselecting every option correctly empties the grid instead of silently clearing the filter.
      case 'set': return m.values == null;
      case 'date': return m.dateFrom == null || m.dateFrom === '';
      case 'number': return m.filter == null || m.filter === '';
      case 'text':
      default: return m.filter == null || m.filter === '';
    }
  }

  /** convenience for the default floating text input. */
  setQuickColumnText(colId: string, text: string, filterType: FilterType = 'text'): void {
    if (!text) { delete this.model[colId]; return; }
    this.model[colId] = { filterType, type: 'contains', filter: text };
  }

  setQuickFilter(text: string): void { this.quickFilter = (text || '').toLowerCase().trim(); }
  getQuickFilter(): string { return this.quickFilter; }

  /** distinct display values for a column's Set Filter, sorted; blanks shown as '(Blanks)'. */
  getDistinctValues(col: Column, nodes: RowNode[]): string[] {
    const set = new Set<string>();
    for (const n of nodes) {
      const raw = col.colDef.filterValueGetter
        ? col.colDef.filterValueGetter(this.values.buildBaseParams(n, col))
        : this.values.getDisplayValue(col, n);
      set.add(raw == null || raw === '' ? '' : String(raw));
    }
    return Array.from(set).sort((a, b) => {
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  isAnyFilterPresent(): boolean {
    return Object.keys(this.model).length > 0 || !!this.quickFilter || !!this.isExternalFilterPresent?.();
  }

  clearAll(): void { this.model = {}; this.quickFilter = ''; }

  // ---- predicate ----
  buildPass(columns: Column[]): (node: RowNode) => boolean {
    const active = Object.keys(this.model)
      .map(colId => ({ col: columns.find(c => c.colId === colId), m: this.model[colId] }))
      .filter(x => x.col) as { col: Column; m: ColumnFilterModel }[];
    const quick = this.quickFilter;
    const hasExternal = !!this.isExternalFilterPresent?.();

    return (node: RowNode): boolean => {
      for (const { col, m } of active) {
        if (!this.columnPasses(col, node, m)) return false;
      }
      if (quick && !this.quickPasses(node, columns, quick)) return false;
      if (hasExternal && this.doesExternalFilterPass && !this.doesExternalFilterPass(node)) return false;
      return true;
    };
  }

  private filterValue(col: Column, node: RowNode): any {
    if (col.colDef.filterValueGetter) {
      return col.colDef.filterValueGetter(this.values.buildBaseParams(node, col));
    }
    return this.values.getValue(col, node);
  }

  private columnPasses(col: Column, node: RowNode, m: ColumnFilterModel): boolean {
    if (m.filterType === 'multi') {
      // agMultiColumnFilter: row must pass every active sub-filter (AND)
      return (m.filters || []).every(sub => this.columnPasses(col, node, sub));
    }
    const raw = this.filterValue(col, node);
    switch (m.filterType) {
      case 'set': {
        // compare on the SAME display value used to build the option list
        const disp = col.colDef.filterValueGetter
          ? String(this.filterValue(col, node) ?? '')
          : String(this.values.getDisplayValue(col, node) ?? '');
        return (m.values || []).map(String).includes(disp);
      }
      case 'number': {
        const v = Number(raw);
        const f = Number(m.filter);
        if (isNaN(v)) return false;
        switch (m.type) {
          case 'equals': return v === f;
          case 'notEqual': return v !== f;
          case 'greaterThan': return v > f;
          case 'greaterThanOrEqual': return v >= f;
          case 'lessThan': return v < f;
          case 'lessThanOrEqual': return v <= f;
          case 'inRange': return v >= Number(m.filter) && v <= Number(m.filterTo);
          default: return String(raw).toLowerCase().includes(String(m.filter).toLowerCase());
        }
      }
      case 'date': {
        const cell = toDateOnly(this.values.getValue(col, node) ?? this.values.getDisplayValue(col, node));
        const from = toDateOnly(m.dateFrom);
        const to = toDateOnly(m.dateTo);
        if (cell == null) return false;
        switch (m.type) {
          case 'equals': return from != null && cell === from;
          case 'notEqual': return from != null && cell !== from;
          case 'lessThan': return from != null && cell < from;      // before
          case 'greaterThan': return from != null && cell > from;   // after
          case 'inRange': return from != null && to != null && cell >= from && cell <= to;
          case 'blank': return false;
          default: return true;
        }
      }
      case 'text':
      default: {
        // match on display value so formatted output (dates, computed) is searchable
        const disp = String(this.values.getDisplayValue(col, node) ?? '').toLowerCase();
        const term = String(m.filter ?? '').toLowerCase();
        switch (m.type) {
          case 'equals': return disp === term;
          case 'notEqual': return disp !== term;
          case 'startsWith': return disp.startsWith(term);
          case 'endsWith': return disp.endsWith(term);
          case 'notContains': return !disp.includes(term);
          case 'contains':
          default: return disp.includes(term);
        }
      }
    }
  }

  private quickPasses(node: RowNode, columns: Column[], quick: string): boolean {
    const parts = quick.split(/\s+/).filter(Boolean);
    const agg = columns
      .filter(c => !c.hide)
      .map(c => String(this.values.getDisplayValue(c, node) ?? ''))
      .join(' ')
      .toLowerCase();
    return parts.every(p => agg.includes(p));
  }
}

/**
 * Normalize a value to a local-midnight timestamp (date-only) for date filtering.
 * Handles Date objects, ISO strings, "yyyy-mm-dd ..." prefixes, and anything Date can
 * parse; returns null when unparseable. Format-agnostic without eval.
 */
export function toDateOnly(value: any): number | null {
  if (value == null || value === '') return null;
  let d: Date;
  if (value instanceof Date) {
    d = value;
  } else {
    const s = String(value).trim();
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);   // yyyy-mm-dd prefix (input & common formats)
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    d = new Date(s);
  }
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
