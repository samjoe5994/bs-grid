import { GridOptions } from '../../api/public-types';
import { Column } from '../models/column.model';
import { RowNode } from '../models/row-node.model';
import { defaultCompare, SortService } from '../sort.service';
import { ValueService } from '../value.service';
import { IRowModel } from './row-model.interface';

export type FilterPass = (node: RowNode) => boolean;

/**
 * ClientSideRowModel — holds the full rowData array in memory, wraps each row in a
 * RowNode with a stable id, and produces the display list by running filter -> (group) ->
 * sort. Row grouping builds a group tree from the columns marked rowGroup, with
 * expand/collapse state persisted by group path and per-group aggregation.
 */
export class ClientSideRowModel implements IRowModel {
  private allNodes: RowNode[] = [];
  private byId = new Map<string, RowNode>();
  private displayed: RowNode[] = [];

  /** group tree root children (kept so expand/collapse re-flattens without regrouping). */
  private groupRoot: RowNode[] = [];
  private expandedState = new Map<string, boolean>();
  groupDefaultExpanded = 0;

  doesPass: FilterPass = () => true;
  getColumns: () => Column[] = () => [];
  /** columns to group by, in order (set by grid-state from rowGroup flags). */
  getGroupColumns: () => Column[] = () => [];
  /** generated pivot columns (each carries pivotValueKeys + pivotValueCol). */
  getPivotColumns: () => Column[] = () => [];
  /** the pivot dimension columns, in order (their display values key the cross-tab). */
  pivotColumns: Column[] = [];
  /** GridApi accessor — custom aggFuncs receive it (AG IAggFuncParams parity). */
  getApi: () => any = () => null;
  /** pivot mode never renders leaf rows (deepest groups are not expandable, matching AG). */
  suppressLeafRows = false;
  grandTotalRow: 'top' | 'bottom' | null = null;
  suppressAggFuncInHeader = false;

  constructor(
    private options: GridOptions,
    private sortService: SortService,
    private valueService: ValueService,
  ) {
    this.groupDefaultExpanded = options['groupDefaultExpanded'] ?? 0;
  }

  /** Owning grid state, attached to every data node so node.setDataValue() works on any node
   *  (from forEachNode, events, allLeafChildren…), as in AG Grid — not only getRowNode(). */
  nodeState: any = null;

  setRowData(rowData: any[]): void {
    this.allNodes = [];
    this.byId.clear();
    (rowData || []).forEach((data, i) => {
      const id = this.resolveId(data, i);
      const node = new RowNode(id, data);
      node.attachState(this.nodeState);
      node.selectable = this.options.isRowSelectable ? this.options.isRowSelectable(node) : true;
      if (this.options.valueCache) node.valueCache = new Map();
      this.allNodes.push(node);
      this.byId.set(id, node);
    });
    this.refresh();
  }

  private resolveId(data: any, index: number): string {
    if (this.options.getRowId) {
      const id = this.options.getRowId({ data });
      if (id != null) return String(id);
    }
    return String(index);
  }

  private grandTotalNode: RowNode | null = null;

  refresh(): void {
    const filtered = this.allNodes.filter(this.doesPass);
    const groupCols = this.getGroupColumns();
    const pivotActive = this.pivotColumns.length > 0 && this.getPivotColumns().length > 0;
    if (groupCols.length) {
      this.groupRoot = this.groupRecursive(filtered, groupCols, 0, '');
      // grand-total row aggregates all filtered leaves across every group
      this.grandTotalNode = this.grandTotalRow ? this.buildTotalNode(filtered) : null;
      this.reflatten();
    } else if (pivotActive) {
      // Pivot with no row groups (crosstab: only Columns dragged) — AG collapses everything
      // into a single aggregated row; we show it as the Total row.
      this.groupRoot = [];
      this.grandTotalNode = this.buildTotalNode(filtered);
      this.reflatten();
    } else {
      this.groupRoot = [];
      this.grandTotalNode = null;
      this.sortService.applySort(filtered, this.getColumns());
      filtered.forEach((n, i) => (n.rowIndex = i));
      this.displayed = filtered;
    }
  }

  /**
   * AG ChangeDetectionService.doChangeDetection: after a cell edit only the aggregates are
   * recomputed. Rows are NOT re-sorted, re-filtered or regrouped, so an edited row stays where
   * the user is looking until the next sort/filter/data change.
   */
  refreshAggregates(): void {
    const walk = (nodes: RowNode[]) => {
      for (const g of nodes) {
        if (!g.group) continue;
        if (g.children) walk(g.children);
        g.aggData = this.computeAgg(g.allLeafChildren ?? [], g);
      }
    };
    walk(this.groupRoot);
    const gt = this.grandTotalNode;
    if (gt) gt.aggData = this.computeAgg(gt.allLeafChildren ?? [], gt);
  }

  private buildTotalNode(filtered: RowNode[]): RowNode {
    const gt = new RowNode('__grandTotal__', null);
    gt.group = true; gt.level = 0; gt.key = 'Total'; gt.groupPath = '__grandTotal__';
    gt.allLeafChildren = filtered; gt.childCount = filtered.length; gt.expanded = false;
    gt.children = []; gt.aggData = this.computeAgg(filtered, gt);
    return gt;
  }

  // ---- grouping ----
  private groupRecursive(nodes: RowNode[], groupCols: Column[], level: number, parentPath: string): RowNode[] {
    if (level >= groupCols.length) {
      // In pivot mode leaf rows are never displayed (AG parity: the deepest pivot group is
      // not expandable), so don't attach them as children.
      if (this.suppressLeafRows) return [];
      this.sortService.applySort(nodes, this.getColumns());
      return nodes;
    }
    const col = groupCols[level];
    const buckets = new Map<string, RowNode[]>();
    for (const n of nodes) {
      const key = String(this.valueService.getDisplayValue(col, n) ?? '');
      let bucket = buckets.get(key);
      if (!bucket) { bucket = []; buckets.set(key, bucket); }
      bucket.push(n);
    }
    const groups: RowNode[] = [];
    for (const [key, groupNodes] of buckets) {
      const path = parentPath + '/' + col.colId + '=' + key;
      const g = new RowNode('__group__' + path, null);
      g.group = true;
      g.level = level;
      g.key = key;
      g.field = col.colDef.field ?? col.colId;
      g.groupColumn = col;
      g.groupPath = path;
      g.allLeafChildren = groupNodes;
      g.childCount = groupNodes.length;
      g.expanded = this.expandedState.has(path) ? this.expandedState.get(path)! : level < this.groupDefaultExpanded;
      g.children = this.groupRecursive(groupNodes, groupCols, level + 1, path);
      g.aggData = this.computeAgg(groupNodes, g);
      groups.push(g);
    }
    groups.sort((a, b) => defaultCompare(a.key, b.key));
    return groups;
  }

  private computeAgg(leaves: RowNode[], groupNode: RowNode): Record<string, any> {
    const agg: Record<string, any> = {};
    const pivotCols = this.getPivotColumns();
    if (this.pivotColumns.length && pivotCols.length) {
      // pivot: each generated column aggregates its value-col over the leaves matching its
      // pivot key tuple (one display value per pivot dimension column, in order).
      // Bucket the leaves by their key tuple ONCE instead of re-filtering the whole leaf set
      // per generated column — with high-cardinality pivots (checkbox questions) that filter
      // was O(leaves × pivot values × measures) per group and froze the crosstab.
      const SEP = '\u0001'; // control char - never occurs in display values
      const buckets = new Map<string, RowNode[]>();
      for (const n of leaves) {
        const key = this.pivotColumns
          .map(pc => String(this.valueService.getDisplayValue(pc, n) ?? ''))
          .join(SEP);
        let bucket = buckets.get(key);
        if (!bucket) { bucket = []; buckets.set(key, bucket); }
        bucket.push(n);
      }
      const EMPTY: RowNode[] = [];
      for (const gcol of pivotCols) {
        const keys: string[] = (gcol as any).pivotValueKeys ?? [];
        const vc = (gcol as any).pivotValueCol as Column;
        const matching = buckets.get(keys.join(SEP)) ?? EMPTY;
        agg[gcol.colId] = this.aggregate(vc, matching, groupNode, gcol);
      }
      return agg;
    }
    // normal grouping aggregation on value columns
    for (const col of this.getColumns()) {
      if (!col.aggFunc) continue;
      agg[col.colId] = this.aggregate(col, leaves, groupNode);
    }
    return agg;
  }

  /** apply a column's aggFunc (string or custom function) over the given leaves. */
  private aggregate(col: Column, leaves: RowNode[], groupNode: RowNode, pivotResultColumn?: Column): any {
    const fn = col.aggFunc;
    const values = leaves.map(n => this.valueService.getValue(col, n));
    if (typeof fn === 'function') {
      // AG IAggFuncParams parity: the crosstab's custom aggFuncs read rowNode.key/rowNode.field
      // to identify the group and api.getColumnState() to find the pivot source column —
      // without these they bail out to 0 for every cell.
      try {
        return (fn as any)({
          values, colDef: col.colDef, column: col,
          rowNode: groupNode, api: this.getApi(),
          context: this.options['context'], pivotResultColumn,
        });
      } catch { return null; }
    }
    const nums = values.map(v => Number(v)).filter(v => !isNaN(v));
    switch (fn) {
      case 'sum': return nums.reduce((s, v) => s + v, 0);
      case 'avg': return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
      case 'min': return nums.length ? Math.min(...nums) : null;
      case 'max': return nums.length ? Math.max(...nums) : null;
      case 'count': return leaves.length;
      case 'first': return values[0];
      case 'last': return values[values.length - 1];
      default: return null;
    }
  }

  private reflatten(): void {
    const out: RowNode[] = [];
    const walk = (nodes: RowNode[]) => {
      for (const n of nodes) {
        out.push(n);
        if (n.group && n.expanded && n.children) walk(n.children);
      }
    };
    // A total node built without grandTotalRow (pivot with no row groups) defaults to bottom.
    const totalPos = this.grandTotalNode ? (this.grandTotalRow ?? 'bottom') : null;
    if (this.grandTotalNode && totalPos === 'top') out.push(this.grandTotalNode);
    walk(this.groupRoot);
    if (this.grandTotalNode && totalPos === 'bottom') out.push(this.grandTotalNode);
    out.forEach((n, i) => (n.rowIndex = i));
    this.displayed = out;
  }

  /**
   * Rows for CSV/Excel export: the full group tree regardless of expansion (AG parity — a
   * collapsed group's sub-groups still export), leaves only outside pivot mode, and the
   * grand-total row in its display position.
   */
  getNodesForExport(): RowNode[] {
    if (!this.groupRoot.length && !this.grandTotalNode) return this.displayed;
    const out: RowNode[] = [];
    const walk = (nodes: RowNode[]) => {
      for (const n of nodes) {
        if (!n.group && this.suppressLeafRows) continue;
        out.push(n);
        if (n.group && n.children) walk(n.children);
      }
    };
    const totalPos = this.grandTotalNode ? (this.grandTotalRow ?? 'bottom') : null;
    if (this.grandTotalNode && totalPos === 'top') out.push(this.grandTotalNode);
    walk(this.groupRoot);
    if (this.grandTotalNode && totalPos === 'bottom') out.push(this.grandTotalNode);
    return out;
  }

  toggleGroupExpanded(node: RowNode): void {
    if (!node.group) return;
    node.expanded = !node.expanded;
    this.expandedState.set(node.groupPath, node.expanded);
    this.reflatten();
  }

  setAllGroupsExpanded(expanded: boolean): void {
    const walk = (nodes: RowNode[]) => {
      for (const n of nodes) {
        if (n.group) { n.expanded = expanded; this.expandedState.set(n.groupPath, expanded); if (n.children) walk(n.children); }
      }
    };
    walk(this.groupRoot);
    this.reflatten();
  }

  getRowCount(): number { return this.displayed.length; }
  getAllCount(): number { return this.allNodes.length; }
  getRow(index: number): RowNode | undefined { return this.displayed[index]; }
  getRowById(id: string): RowNode | undefined { return this.byId.get(id); }
  getDisplayedNodes(): RowNode[] { return this.displayed; }
  getAllNodes(): RowNode[] { return this.allNodes; }

  forEachNode(cb: (n: RowNode, i: number) => void): void { this.allNodes.forEach(cb); }
  forEachNodeAfterFilterAndSort(cb: (n: RowNode, i: number) => void): void { this.displayed.forEach(cb); }

  // ---- transactions ----
  applyTransaction(tx: { add?: any[]; update?: any[]; remove?: any[] }): void {
    if (tx.remove) {
      for (const data of tx.remove) {
        const id = this.resolveId(data, -1);
        const node = this.byId.get(id);
        if (node) {
          this.byId.delete(id);
          const idx = this.allNodes.indexOf(node);
          if (idx > -1) this.allNodes.splice(idx, 1);
        }
      }
    }
    if (tx.update) {
      for (const data of tx.update) {
        const id = this.resolveId(data, -1);
        const node = this.byId.get(id);
        if (node) { node.data = data; node.valueCache?.clear(); }
      }
    }
    if (tx.add) {
      tx.add.forEach(data => {
        const id = this.resolveId(data, this.allNodes.length);
        const node = new RowNode(id, data);
        node.attachState(this.nodeState);
        if (this.options.valueCache) node.valueCache = new Map();
        this.allNodes.push(node);
        this.byId.set(id, node);
      });
    }
    this.refresh();
  }
}
