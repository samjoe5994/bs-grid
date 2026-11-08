import { Injectable } from '@angular/core';
import { CellRange } from './models/cell-range.model';

interface RangeCorner { rowIndex: number; colId: string; }

/**
 * RangeSelectionService — Excel-style rectangular cell range selection (the AG
 * `enableRangeSelection`/`cellSelection` feature BsGrid dropped in the ag-grid → bs-grid
 * migration; see docs/bs-grid/SPEC.md). Tracks an anchor (where the drag/shift-extension
 * started) and a focus (the other corner); the normalized rectangle between them is the
 * "live" range currently being drawn. `committed` holds every range from an EARLIER drag in
 * the same multi-range session — AG parity: a plain drag/click always clears everything and
 * starts fresh, but Ctrl+drag either adds a brand-new independent range (freezing the
 * previous live one into `committed` first) or, if the drag started on a cell already inside
 * an existing range, DESELECTS the dragged-over cells from that one range instead — which can
 * split it into up to 4 leftover rectangles (subtractRect). One instance per <bs-grid>
 * (component-level provider), inert unless the host binds [enableRangeSelection]="true".
 */
@Injectable()
export class RangeSelectionService {
  enabled = false;

  private committed: CellRange[] = [];
  private anchor: RangeCorner | null = null;
  private focus: RangeCorner | null = null;
  private orderedColIds: string[] = [];

  /** True while anchor/focus represent a genuine ADDITIONAL selected range (a plain drag, or
   *  an additive Ctrl+drag that isn't over an existing range). False while anchor/focus are
   *  merely tracking the cursor for a Ctrl+drag DESELECT — that rectangle only ever removes
   *  cells from `subtractFrom`, it never itself counts as selected. */
  private activeIsRange = true;
  /** Set for the duration of a Ctrl+drag that began inside an already-selected range — that
   *  range is held here (and pulled out of `committed`) so isCellInRange can render the
   *  in-progress deselection live, then `end()` splices its leftover pieces back in. */
  private subtractFrom: CellRange | null = null;

  private rangesCache: CellRange[] | null = null;

  /** Visible column order (left+center+right), captured once at the start of a drag/keyboard
   *  session so a range's column span is stable for its duration. */
  setOrderedColIds(ids: string[]): void {
    this.orderedColIds = ids;
  }

  /**
   * Begin a new range at (rowIndex, colId).
   * - additive=false (plain click/drag): clears every existing range first (AG: "a range will
   *   be created between the two cells and clear any existing ranges").
   * - additive=true (Ctrl held): freezes the current live range into `committed`, then either
   *   starts a brand-new independent range, or — if this cell already lies inside an existing
   *   range — begins a DESELECT drag against that range instead (AG parity).
   */
  start(rowIndex: number, colId: string, additive = false): void {
    if (!this.enabled) return;
    if (!additive) {
      this.committed = [];
      this.subtractFrom = null;
    } else {
      this.commitActive();
      this.subtractFrom = this.findContaining(rowIndex, colId);
      if (this.subtractFrom) this.committed = this.committed.filter(r => r !== this.subtractFrom);
    }
    this.anchor = { rowIndex, colId };
    this.focus = { rowIndex, colId };
    this.activeIsRange = !this.subtractFrom;
    this.invalidate();
  }

  /** Moves the free corner; returns true if the normalized range actually changed shape
   *  (callers use this to gate change-detection / event emission). */
  extendTo(rowIndex: number, colId: string): boolean {
    if (!this.enabled || !this.anchor) return false;
    if (this.focus && this.focus.rowIndex === rowIndex && this.focus.colId === colId) return false;
    this.focus = { rowIndex, colId };
    this.invalidate();
    return true;
  }

  /** Finalize the in-progress drag (call on pointerup). A no-op for a plain/additive-add
   *  drag — its anchor/focus simply stay live for continued Shift+Arrow/keyboard use, exactly
   *  as before multi-range support. For a Ctrl+drag DESELECT, splices the target range's
   *  leftover pieces (base minus the dragged rectangle) back into `committed` and drops the
   *  live rectangle entirely — it was a removal, not a selection. */
  end(): void {
    if (this.subtractFrom && this.anchor && this.focus) {
      const live = this.liveRect();
      if (live) this.committed.push(...this.subtractRect(this.subtractFrom, live));
      this.subtractFrom = null;
      this.anchor = null;
      this.focus = null;
      this.activeIsRange = true;
    }
    this.invalidate();
  }

  /** Freezes the current live range (if it's a genuine positive selection) into `committed`
   *  and clears anchor/focus — used before starting a new additive range so the previous one
   *  isn't overwritten. */
  private commitActive(): void {
    if (this.activeIsRange) {
      const r = this.liveRect();
      if (r) this.committed.push(r);
    }
    this.anchor = null;
    this.focus = null;
    this.activeIsRange = true;
  }

  clear(): void {
    this.committed = [];
    this.anchor = null;
    this.focus = null;
    this.subtractFrom = null;
    this.activeIsRange = true;
    this.invalidate();
  }

  /** Imperative form (GridApi.addCellRange): set the range directly from a row span + an
   *  ordered colId list, rather than via anchor-drag/keyboard-extend. `orderedColIds` must
   *  already be set to the layout the given colIds were resolved against. Replaces any
   *  existing multi-range selection, matching addCellRange's AG contract. */
  setRange(rowStartIndex: number, rowEndIndex: number, colIds: string[]): void {
    if (!colIds.length) { this.clear(); return; }
    this.committed = [];
    this.subtractFrom = null;
    this.anchor = { rowIndex: rowStartIndex, colId: colIds[0] };
    this.focus = { rowIndex: rowEndIndex, colId: colIds[colIds.length - 1] };
    this.activeIsRange = true;
    this.invalidate();
  }

  hasRange(): boolean { return this.committed.length > 0 || (this.activeIsRange && !!this.anchor); }

  getAnchor(): RangeCorner | null { return this.anchor; }
  getFocus(): RangeCorner | null { return this.focus; }
  getOrderedColIds(): string[] { return this.orderedColIds; }

  private invalidate(): void {
    this.rangesCache = null;
  }

  /** Every currently-selected rectangle — one or more with multi-range (Ctrl+drag) selection. */
  getRanges(): CellRange[] {
    if (this.rangesCache) return this.rangesCache;
    const out = [...this.committed];
    if (this.activeIsRange) {
      const live = this.liveRect();
      if (live) out.push(live);
    }
    this.rangesCache = out;
    return out;
  }

  /** The rectangle currently spanned by anchor/focus, normalized — regardless of whether it
   *  counts as a positive selection (activeIsRange) or a live subtract-preview. */
  private liveRect(): CellRange | null {
    if (!this.anchor || !this.focus) return null;
    const aIdx = this.orderedColIds.indexOf(this.anchor.colId);
    const fIdx = this.orderedColIds.indexOf(this.focus.colId);
    if (aIdx === -1 || fIdx === -1) return null;
    const lo = Math.min(aIdx, fIdx);
    const hi = Math.max(aIdx, fIdx);
    return {
      startRowIndex: Math.min(this.anchor.rowIndex, this.focus.rowIndex),
      endRowIndex: Math.max(this.anchor.rowIndex, this.focus.rowIndex),
      columns: this.orderedColIds.slice(lo, hi + 1),
    };
  }

  private rangeHasCell(r: CellRange, rowIndex: number, colId: string): boolean {
    return rowIndex >= r.startRowIndex && rowIndex <= r.endRowIndex && r.columns.includes(colId);
  }

  private findContaining(rowIndex: number, colId: string): CellRange | null {
    return this.committed.find(r => this.rangeHasCell(r, rowIndex, colId)) ?? null;
  }

  isCellInRange(rowIndex: number, colId: string): boolean {
    for (const r of this.committed) {
      if (!this.rangeHasCell(r, rowIndex, colId)) continue;
      if (r === this.subtractFrom) {
        const live = this.liveRect();
        if (live && this.rangeHasCell(live, rowIndex, colId)) continue;   // live-excluded
      }
      return true;
    }
    if (this.activeIsRange) {
      const live = this.liveRect();
      if (live && this.rangeHasCell(live, rowIndex, colId)) return true;
    }
    return false;
  }

  /** Is this cell on the OUTER edge of the union of all selected ranges — i.e. its neighbor in
   *  that direction isn't itself selected. Union-based (not per-rectangle) so two ranges that
   *  happen to touch render as one seamless block instead of drawing an internal border. */
  isRangeEdge(rowIndex: number, colId: string, edge: 'top' | 'right' | 'bottom' | 'left'): boolean {
    if (!this.isCellInRange(rowIndex, colId)) return false;
    if (edge === 'top') return !this.isCellInRange(rowIndex - 1, colId);
    if (edge === 'bottom') return !this.isCellInRange(rowIndex + 1, colId);
    const idx = this.orderedColIds.indexOf(colId);
    if (edge === 'left') return idx <= 0 || !this.isCellInRange(rowIndex, this.orderedColIds[idx - 1]);
    return idx === -1 || idx === this.orderedColIds.length - 1 || !this.isCellInRange(rowIndex, this.orderedColIds[idx + 1]);
  }

  isAnchorCell(rowIndex: number, colId: string): boolean {
    return !!this.anchor && this.anchor.rowIndex === rowIndex && this.anchor.colId === colId;
  }

  /** True when the overall selection is worth highlighting/aggregating as a "range" — either
   *  more than one rectangle is selected (even if each is a single cell — e.g. two Ctrl+clicked
   *  cells), or the one selected rectangle spans more than a single cell. A plain click (no
   *  drag, no Ctrl, no shift) collapses to one 1x1 range, which callers treat as "no meaningful
   *  selection" for rendering. */
  isMultiCell(): boolean {
    const ranges = this.getRanges();
    if (ranges.length > 1) return true;
    const r = ranges[0];
    return !!r && (r.startRowIndex !== r.endRowIndex || r.columns.length > 1);
  }

  /**
   * Rectangle subtraction: `base` minus `cut` (both already resolved against orderedColIds),
   * clipped to base's own bounds. Standard 4-piece decomposition — up to a top strip, a bottom
   * strip, and left/right strips of the remaining middle row-band — whose union is exactly
   * base minus the overlap. Returns [base] unchanged if cut doesn't actually overlap it.
   */
  private subtractRect(base: CellRange, cut: CellRange): CellRange[] {
    const colIdx = (id: string) => this.orderedColIds.indexOf(id);
    const bLo = colIdx(base.columns[0]);
    const bHi = colIdx(base.columns[base.columns.length - 1]);
    const cLo = colIdx(cut.columns[0]);
    const cHi = colIdx(cut.columns[cut.columns.length - 1]);
    const rowLo = Math.max(base.startRowIndex, cut.startRowIndex);
    const rowHi = Math.min(base.endRowIndex, cut.endRowIndex);
    const colLo = Math.max(bLo, cLo);
    const colHi = Math.min(bHi, cHi);
    if (rowLo > rowHi || colLo > colHi) return [base];

    const pieces: CellRange[] = [];
    const slice = (r0: number, r1: number, c0: number, c1: number) => pieces.push({
      startRowIndex: r0, endRowIndex: r1, columns: this.orderedColIds.slice(c0, c1 + 1),
    });
    if (base.startRowIndex < rowLo) slice(base.startRowIndex, rowLo - 1, bLo, bHi);   // top strip
    if (rowHi < base.endRowIndex) slice(rowHi + 1, base.endRowIndex, bLo, bHi);       // bottom strip
    if (bLo < colLo) slice(rowLo, rowHi, bLo, colLo - 1);                             // middle-left strip
    if (colHi < bHi) slice(rowLo, rowHi, colHi + 1, bHi);                             // middle-right strip
    return pieces;
  }
}
