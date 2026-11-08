import { Injectable } from '@angular/core';
import { BsCellParams, ColDef } from '../api/public-types';
import { Column } from './models/column.model';
import { RowNode } from './models/row-node.model';

/**
 * ValueService — resolves the cell value pipeline:
 *   read:  valueGetter ?? data[field]  -> valueFormatter -> (display)
 *   write: newValue -> valueParser -> valueSetter (or data[field] = v)
 *
 * Value functions are used in **function form** throughout the codebase (see
 * docs/bs-grid/RESEARCH.md Part E). We therefore support function form fully and treat
 * the string form as a **safe dotted field path** (e.g. "data.data.email") rather than an
 * arbitrary compiled expression — this avoids any `new Function`/eval code-injection
 * surface while covering the realistic string-getter cases. Values are memoized per
 * (rowId,colId) when valueCache is enabled, and the nested `data.data[field]` shape used
 * by contacts/campaign grids is handled by the dotted-path resolver.
 */
@Injectable()
export class ValueService {
  valueCacheEnabled = false;

  /** paramsFactory lets callers inject api/context without a cycle. */
  buildBaseParams: (node: RowNode, column: Column) => BsCellParams = () => ({} as any);

  getValue(column: Column, node: RowNode): any {
    if (this.valueCacheEnabled && node.valueCache?.has(column.colId)) {
      return node.valueCache.get(column.colId);
    }
    const colDef = column.colDef;
    let value: any;
    if (colDef.valueGetter != null) {
      value = this.runExpr(colDef.valueGetter, this.params(node, column));
    } else if (colDef.field != null) {
      value = getFieldValue(node.data, colDef.field);
    } else {
      value = undefined;
    }
    if (this.valueCacheEnabled) {
      (node.valueCache ??= new Map()).set(column.colId, value);
    }
    return value;
  }

  formatValue(column: Column, node: RowNode, value: any): string | null {
    const fmt = column.colDef.valueFormatter;
    if (fmt == null) return null;
    const p = this.params(node, column);
    p.value = value;
    return this.runExpr(fmt, p);
  }

  /** Value shown in a cell: formatted string if a formatter exists, else the raw value. */
  getDisplayValue(column: Column, node: RowNode): any {
    const value = this.getValue(column, node);
    const formatted = this.formatValue(column, node, value);
    return blankNaN(formatted != null ? formatted : value);
  }

  parseValue(column: Column, node: RowNode, newValue: any): any {
    const parser = column.colDef.valueParser;
    if (parser == null) return newValue;
    const p = this.params(node, column);
    p['newValue'] = newValue;
    return this.runExpr(parser, p);
  }

  /** Write an edited value back. Returns true if the data changed. */
  setValue(column: Column, node: RowNode, newValue: any): boolean {
    const colDef = column.colDef;
    const parsed = this.parseValue(column, node, newValue);
    if (colDef.valueSetter != null) {
      const p = this.params(node, column);
      p['newValue'] = parsed;
      const changed = this.runExpr(colDef.valueSetter, p);
      this.invalidate(node, column);
      return changed !== false;
    }
    if (colDef.field != null) {
      const old = getFieldValue(node.data, colDef.field);
      if (old === parsed) return false;
      setFieldValue(node.data, colDef.field, parsed);
      this.invalidate(node, column);
      return true;
    }
    return false;
  }

  invalidate(node: RowNode, column?: Column): void {
    if (!node.valueCache) return;
    if (column) node.valueCache.delete(column.colId);
    else node.valueCache.clear();
  }

  private params(node: RowNode, column: Column): BsCellParams {
    const base = this.buildBaseParams(node, column);
    return base;
  }

  private runExpr(fnOrStr: any, params: BsCellParams): any {
    if (typeof fnOrStr === 'function') return fnOrStr(params);
    if (typeof fnOrStr === 'string') {
      // SAFE string form: treat as a dotted field path against `data` (no eval).
      // Accept a leading "data." prefix (common AG string-getter style) and resolve
      // the remainder as a path. Anything not resolvable returns undefined.
      const path = fnOrStr.startsWith('data.') ? fnOrStr.slice(5) : fnOrStr;
      return getFieldValue(params.data, path);
    }
    return undefined;
  }
}

/**
 * Coerce a NaN result to blank for display/export. Number-column formatters in the host
 * (e.g. `params.value.toFixed(2)`) yield the literal "NaN" / a NaN number when a cell has no
 * numeric answer; that must never reach a cell or an exported CSV. Only genuine NaN is stripped
 * (real answers never render as the bare token "NaN"), so no valid value is lost.
 */
function blankNaN(v: any): any {
  if (typeof v === 'number' && Number.isNaN(v)) return '';
  if (typeof v === 'string' && v === 'NaN') return '';
  return v;
}

/** Resolve `a.b.c` dotted paths against an object; falls back to a flat key. */
export function getFieldValue(data: any, field: string): any {
  if (data == null) return undefined;
  if (field.indexOf('.') === -1) return data[field];
  let cur = data;
  for (const part of field.split('.')) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setFieldValue(data: any, field: string, value: any): void {
  if (data == null) return;
  if (field.indexOf('.') === -1) { data[field] = value; return; }
  const parts = field.split('.');
  let cur = data;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]] ??= {};
  }
  cur[parts[parts.length - 1]] = value;
}
