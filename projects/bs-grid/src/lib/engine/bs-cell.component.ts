import {
  ChangeDetectionStrategy, Component, ComponentRef, ElementRef, Input, OnChanges,
  OnDestroy, SimpleChanges, ViewChild, ViewContainerRef,
} from '@angular/core';
import { NgIf } from '@angular/common';
import { BsCellParams } from '../api/public-types';
import { GridStateService } from '../core/grid-state.service';
import { Column } from '../core/models/column.model';
import { RowNode } from '../core/models/row-node.model';

/**
 * BsCell — renders one cell's content. Three modes:
 *  1. default: text of the display value.
 *  2. renderer: a dynamically-mounted Angular component (colDef.cellRenderer /
 *     cellRendererSelector), driven by the AG duck-typed contract agInit(params) +
 *     refresh(params) — so existing BlockSurvey renderers work unchanged. refresh()===false
 *     recreates the component; ===true keeps it (the perf contract).
 *  3. editor: on `editing`, mounts the cell editor (colDef.cellEditor) or a default text
 *     input; commits via getValue() -> valueSetter -> cellValueChanged.
 * SSR-safe: dynamic component creation is fine on the server; the renderers themselves
 * guard their own browser access.
 */
@Component({
  selector: 'bs-cell',
  imports: [NgIf],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-container #rendererHost></ng-container>
    <span class="bs-grid-cell-value" *ngIf="showDefault" [title]="tooltip">{{ display }}</span>
    <ng-container #editorHost></ng-container>
  `,
})
export class BsCellComponent implements OnChanges, OnDestroy {
  @Input() column!: Column;
  @Input() node!: RowNode;
  @Input() editing = false;
  // Increments when the grid refreshes cells in place (applyTransaction update / setDataValue /
  // refreshCells). The node reference is unchanged in those cases, so this changing input is what
  // triggers ngOnChanges -> renderContent() to re-read the (mutated) node.data. See refreshCells().
  @Input() tick = 0;

  @ViewChild('rendererHost', { read: ViewContainerRef, static: true }) rendererHost!: ViewContainerRef;
  @ViewChild('editorHost', { read: ViewContainerRef, static: true }) editorHost!: ViewContainerRef;

  showDefault = true;
  display: any = '';
  tooltip = '';

  private rendererRef: ComponentRef<any> | null = null;
  private editorRef: ComponentRef<any> | null = null;
  private editorEl?: HTMLInputElement;
  private defaultEditValue: any = null;
  private editorNumeric = false;

  constructor(private state: GridStateService, private host: ElementRef<HTMLElement>) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['editing']) {
      if (this.editing) this.startEditor();
      else this.destroyEditor();
    }
    if (!this.editing) this.renderContent();
  }

  ngOnDestroy(): void {
    this.rendererRef?.destroy();
    this.editorRef?.destroy();
    this.clearFunctionEl();
  }

  // ---- render ----
  private renderContent(): void {
    const colDef = this.column.colDef;
    let comp = colDef.cellRenderer;
    if (colDef.cellRendererSelector) {
      const sel = colDef.cellRendererSelector(this.params());
      comp = sel?.component ?? comp;
    }

    // (1) Angular component renderer (ICellRendererAngularComp): mount dynamically.
    if (comp && typeof comp !== 'string' && this.isAngularComponent(comp)) {
      this.clearFunctionEl();
      this.showDefault = false;
      const params = this.params(colDef.cellRendererParams);
      if (this.rendererRef && this.rendererComp === comp) {
        // reuse: honor the refresh() boolean contract
        const keep = this.rendererRef.instance.refresh?.(params);
        if (keep === false) this.mountRenderer(comp, params);
        else this.rendererRef.changeDetectorRef.markForCheck();
      } else {
        this.mountRenderer(comp, params);
      }
      return;
    }

    // (2) Plain function renderer `(params) => string|HTMLElement` or a vanilla
    //     ICellRendererComp class (has prototype.getGui). AG Grid supports these and
    //     BlockSurvey column defs use them (e.g. `cellRenderer: (params) => params.value`),
    //     so calling createComponent() on them would throw — handle them here instead.
    if (comp && typeof comp === 'function') {
      if (this.rendererRef) { this.rendererRef.destroy(); this.rendererRef = null; }
      this.renderFunctionRenderer(comp, this.params(colDef.cellRendererParams));
      return;
    }

    // (3) Default (or unsupported string renderer): plain text of the display value.
    this.clearFunctionEl();
    this.showDefault = true;
    if (this.rendererRef) { this.rendererRef.destroy(); this.rendererRef = null; }
    this.display = this.state.values.getDisplayValue(this.column, this.node);
    this.tooltip = this.computeTooltip();
  }

  /** True for a compiled Angular component/directive class (AOT sets ɵcmp/ɵfac). */
  private isAngularComponent(comp: any): boolean {
    return !!(comp && (comp.ɵcmp || comp.ɵfac));
  }

  private functionEl?: HTMLElement;
  private clearFunctionEl(): void {
    if (this.functionEl) { this.functionEl.remove(); this.functionEl = undefined; }
  }

  /**
   * Render the output of a function renderer or a vanilla ICellRendererComp class.
   * String/number/null results route through the default text span (safe + tooltip-aware);
   * HTMLElement / getGui() results are appended to the host. SSR-safe: strings need no DOM,
   * and the HTMLElement branch is guarded for the server.
   */
  private renderFunctionRenderer(comp: any, params: BsCellParams): void {
    let result: any;
    if (comp.prototype && typeof comp.prototype.getGui === 'function') {
      const inst = new comp();
      inst.init?.(params);
      result = inst.getGui?.();
    } else {
      result = comp(params);
    }

    const isEl = typeof HTMLElement !== 'undefined' && result instanceof HTMLElement;
    const gui = !isEl && result && typeof result.getGui === 'function' ? result.getGui() : null;
    if (isEl || gui) {
      this.clearFunctionEl();
      this.showDefault = false;
      this.functionEl = (isEl ? result : gui) as HTMLElement;
      this.functionEl.classList.add('bs-grid-cell-fn');
      this.host.nativeElement.appendChild(this.functionEl);
      return;
    }

    // string / number / null → default text span
    this.clearFunctionEl();
    this.showDefault = true;
    this.display = result == null ? '' : result;
    this.tooltip = this.computeTooltip();
  }

  /**
   * Tooltip text: colDef.tooltipValueGetter/tooltipField if provided, else the display
   * value so any truncated cell reveals its full content on hover. Native `title` — zero
   * JS, SSR-safe, and shows only when the browser deems it useful.
   */
  private computeTooltip(): string {
    const colDef = this.column.colDef;
    if (colDef.tooltipValueGetter) {
      const t = colDef.tooltipValueGetter(this.params());
      return t == null ? '' : String(t);
    }
    if (colDef.tooltipField) {
      const v = this.node.data?.[colDef.tooltipField];
      return v == null ? '' : String(v);
    }
    return this.display == null ? '' : String(this.display);
  }

  private rendererComp: any = null;
  private mountRenderer(comp: any, params: BsCellParams): void {
    this.rendererHost.clear();
    this.rendererRef = this.rendererHost.createComponent(comp);
    this.rendererComp = comp;
    this.rendererRef.instance.agInit?.(params);
    this.rendererRef.changeDetectorRef.markForCheck();
  }

  // ---- edit ----
  private startEditor(): void {
    this.showDefault = false;
    this.rendererRef?.destroy();
    this.rendererRef = null;
    this.clearFunctionEl();
    this.state.view?.registerEditingCell(this);
    const colDef = this.column.colDef;
    let comp = colDef.cellEditor;
    if (colDef.cellEditorSelector) {
      const sel = colDef.cellEditorSelector(this.params());
      comp = sel?.component ?? comp;
    }
    const value = this.state.values.getValue(this.column, this.node);
    const params = this.params(colDef.cellEditorParams);
    params.value = value;
    params['stopEditing'] = (cancel?: boolean) => this.state.view?.stopEditing(cancel);

    if (comp && typeof comp !== 'string') {
      // custom Angular editor component
      this.editorHost.clear();
      this.editorRef = this.editorHost.createComponent(comp);
      this.editorRef.instance.agInit?.(params);
      Promise.resolve().then(() => this.editorRef?.instance.afterGuiAttached?.());
    } else if (comp === 'agSelectCellEditor' || comp === 'agRichSelectCellEditor') {
      // built-in dropdown editor: native <select> from cellEditorParams.values
      this.startSelectEditor(value, params);
    } else {
      this.startTextEditor(value, this.resolveEditorInputType(value));
    }
  }

  /**
   * Pick the native input type for the default editor from the column's editor/data/filter hints.
   * Date-ish columns may carry either a plain date or a date+time value; a native `date` input
   * silently renders blank when handed a value that includes a time component, so we resolve to
   * `datetime-local` when the column (or its current value) is a date+time. An explicit colDef hint
   * wins; otherwise we infer from the value's shape (consumers often mark both date and date+time
   * columns with `agDateColumnFilter`, so the filter alone can't distinguish them).
   */
  private resolveEditorInputType(value?: any): 'text' | 'number' | 'date' | 'datetime-local' {
    const cd: any = this.column.colDef;
    const ce = cd.cellEditor;
    if (ce === 'agNumberCellEditor') return 'number';
    if (cd.cellDataType === 'number' || cd.filter === 'agNumberColumnFilter') return 'number';

    const explicitDateTime =
      ce === 'agDateTimeCellEditor' || cd.cellDataType === 'dateTime' || cd.cellDataType === 'datetime';
    const explicitDate =
      ce === 'agDateCellEditor' || ce === 'agDateStringCellEditor' || cd.cellDataType === 'date';
    const dateLike = explicitDate || explicitDateTime || cd.filter === 'agDateColumnFilter';
    if (!dateLike) return 'text';
    if (explicitDateTime) return 'datetime-local';
    if (explicitDate) return 'date';
    return this.valueHasTimeComponent(value) ? 'datetime-local' : 'date';
  }

  /** True when a rendered date value carries a time component (e.g. "2026-07-16 4:54 PM", "…T16:54"). */
  private valueHasTimeComponent(value: any): boolean {
    if (value == null) return false;
    const s = String(value);
    return /\d{1,2}:\d{2}/.test(s) || /\b[AaPp][Mm]\b/.test(s) || /T\d{2}:\d{2}/.test(s);
  }

  /**
   * Normalize a value into the exact string a native `date` / `datetime-local` input requires
   * (`yyyy-MM-dd` / `yyyy-MM-ddTHH:mm`), else the input renders blank. Returns '' for unparseable
   * values. Pure date-only ISO strings are sliced literally to avoid the UTC-midnight day-shift
   * that `new Date('yyyy-MM-dd')` introduces in negative-offset timezones.
   */
  private toNativeDateValue(value: any, type: 'date' | 'datetime-local'): string {
    if (value == null || value === '') return '';
    const s = String(value).trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
    const d = new Date(s);
    const pad = (n: number) => String(n).padStart(2, '0');
    if (isNaN(d.getTime())) {
      return type === 'date' && iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : '';
    }
    if (type === 'date') {
      if (iso && !iso[4]) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private startSelectEditor(value: any, params: any): void {
    this.defaultEditValue = value;
    const select = document.createElement('select');
    select.className = 'bs-grid-inline-editor bs-grid-inline-select';
    const values: any[] = params.values || params.cellEditorParams?.values || [];
    // A native <select> with no selected option silently shows its first option, which reads
    // as the grid auto-picking it — and leaves no way to keep or clear an empty cell. Offer a
    // blank option (unless the column's values already include one) and select it whenever the
    // current value is empty or matches no option.
    const toVal = (v: any) => (v != null && typeof v === 'object' ? (v.value ?? v.id ?? v.label) : v);
    let blankOpt: HTMLOptionElement | null = null;
    let matched = false;
    if (!values.some(v => { const val = toVal(v); return val == null || String(val) === ''; })) {
      blankOpt = document.createElement('option');
      blankOpt.value = '';
      blankOpt.textContent = '';
      select.appendChild(blankOpt);
    }
    for (const v of values) {
      const opt = document.createElement('option');
      const val = toVal(v);
      const label = v != null && typeof v === 'object' ? (v.label ?? v.value ?? v.id) : v;
      opt.value = val == null ? '' : String(val);
      opt.textContent = label == null ? '' : String(label);
      if (!blankOpt && opt.value === '') blankOpt = opt;
      if (String(val) === String(value)) { opt.selected = true; matched = true; }
      select.appendChild(opt);
    }
    if (!matched && blankOpt) blankOpt.selected = true;
    select.addEventListener('change', () => {
      this.defaultEditValue = select.value;
      this.state.view?.stopEditing(false);
    });
    select.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.state.view?.handleEditorEscape();
      else if (e.key === 'Enter') this.state.view?.handleEditorEnter(e.ctrlKey || e.metaKey);
      else if (e.key === 'Tab') { e.preventDefault(); this.state.view?.handleEditorTab(e.shiftKey); }
    });
    if (this.state.options.stopEditingWhenCellsLoseFocus) {
      select.addEventListener('blur', () => this.state.view?.stopEditing(false));
    }
    this.host.nativeElement.appendChild(select);
    this.editorEl = select as any;
    Promise.resolve().then(() => { select.focus(); });
  }

  private startTextEditor(value: any, type: 'text' | 'number' | 'date' | 'datetime-local' = 'text'): void {
    this.editorNumeric = type === 'number';
    const input = document.createElement('input');
    input.type = type;
    input.className = 'bs-grid-inline-editor bs-grid-inline-editor--' + type;
    // Native date/datetime-local inputs only accept a strict string form; hand them anything else
    // (e.g. "2026-07-16 4:54 PM") and they silently render blank. Normalize before seeding.
    const initial = (type === 'date' || type === 'datetime-local')
      ? this.toNativeDateValue(value, type)
      : (value == null ? '' : String(value));
    input.value = initial;
    this.defaultEditValue = initial;
    input.addEventListener('input', () => (this.defaultEditValue = input.value));
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') this.state.view?.handleEditorEnter(e.ctrlKey || e.metaKey);
      else if (e.key === 'Escape') this.state.view?.handleEditorEscape();
      else if (e.key === 'Tab') { e.preventDefault(); this.state.view?.handleEditorTab(e.shiftKey); }
    });
    if (this.state.options.stopEditingWhenCellsLoseFocus) {
      input.addEventListener('blur', () => this.state.view?.stopEditing(false));
    }
    this.host.nativeElement.appendChild(input);
    this.editorEl = input;
    Promise.resolve().then(() => {
      input.focus();
      // select() is only valid for text-like inputs; date/number throw InvalidStateError.
      if (type === 'text') { try { input.select(); } catch { /* noop */ } }
    });
  }

  /** Called by the grid when editing ends. Returns the committed value (or undefined if cancelled). */
  commitValue(): any {
    if (this.editorRef) {
      if (this.editorRef.instance.isCancelAfterEnd?.()) return undefined;
      return this.editorRef.instance.getValue?.();
    }
    if (this.editorEl) {
      const v = this.defaultEditValue;
      if (this.editorNumeric && v !== '' && v != null && !isNaN(Number(v))) return Number(v);
      return v;
    }
    return undefined;
  }

  private destroyEditor(): void {
    this.editorHost?.clear();
    this.editorRef = null;
    if (this.editorEl) { this.editorEl.remove(); this.editorEl = undefined; }
  }

  private params(extra?: any): BsCellParams {
    const base = this.state.values.buildBaseParams(this.node, this.column);
    base.value = this.state.values.getValue(this.column, this.node);
    base.valueFormatted = this.state.values.formatValue(this.column, this.node, base.value);
    return extra ? { ...base, ...extra } : base;
  }
}
