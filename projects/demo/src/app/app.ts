import { Component, ElementRef, ViewChild } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  BsCellParams, BsGridComponent, ColDef, GridApi, GridReadyEvent,
  ICellEditorAngularComp, ICellRendererAngularComp, PaginationChangedEvent,
} from '@samjoe5994/bs-grid';

@Component({
  selector: 'demo-status-cell',
  template: `<span class="pill" [class.pill--on]="value === 'active'">{{ value }}</span>`,
  styles: [`
    .pill { display:inline-block; padding:1px 8px; border-radius:10px; font-size:11px;
            background:#eee; color:#555; text-transform:capitalize; }
    .pill--on { background:#e6f4ea; color:#137333; }
  `],
})
export class StatusRendererComponent implements ICellRendererAngularComp {
  value = '';
  agInit(params: BsCellParams): void { this.value = params.value; }
  refresh(params: BsCellParams): boolean { this.value = params.value; return true; }
}

/** A custom Angular cell editor (uppercases the email) to exercise the editor contract. */
@Component({
  selector: 'demo-email-editor',
  template: `<input #box class="demo-editor" [value]="value" (input)="value = box.value" />`,
  styles: [`.demo-editor { width: 100%; height: 100%; box-sizing: border-box; border: 2px solid #7f95d1; font: inherit; padding: 0 6px; }`],
})
export class EmailEditorComponent implements ICellEditorAngularComp {
  @ViewChild('box') box?: ElementRef<HTMLInputElement>;
  value = '';
  agInit(params: { value: string }): void { this.value = params.value ?? ''; }
  afterGuiAttached(): void { this.box?.nativeElement.focus(); this.box?.nativeElement.select(); }
  getValue(): string { return this.value.trim().toUpperCase(); }
}

const FIRST = ['Ada', 'Alan', 'Grace', 'Linus', 'Barbara', 'Ken', 'Margaret', 'Edsger', 'Katherine', 'Tim'];
const LAST = ['Lovelace', 'Turing', 'Hopper', 'Torvalds', 'Liskov', 'Thompson', 'Hamilton', 'Dijkstra', 'Johnson', 'Berners-Lee'];
const COUNTRY = ['India', 'United States', 'Germany', 'Japan', 'Brazil', 'Kenya', 'Canada', 'France'];
const PLAN = ['free', 'pro', 'team', 'enterprise'];

interface DemoRow {
  id: number; name: string; email: string; country: string; plan: string; status: string;
  responses: number; completion: number; signedUp: string; lastSeen: string;
}

@Component({
  selector: 'app-root',
  imports: [BsGridComponent, FormsModule, DecimalPipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private api?: GridApi;

  dark = false;
  paged = false;
  autoPageSize = false;
  quickFilter = '';
  selectedCount = 0;
  rowData: DemoRow[] = [];
  /** Last events emitted by the grid, newest first, so you can watch outputs fire. */
  events: string[] = [];

  defaultColDef: ColDef = { sortable: true, filter: true, resizable: true, minWidth: 110, enableRowGroup: true };

  columnDefs: ColDef[] = [
    { field: 'id', headerName: 'ID', width: 90, pinned: 'left', filter: 'agNumberColumnFilter' },
    { field: 'name', headerName: 'Name', width: 200, pinned: 'left', checkboxSelection: true, headerCheckboxSelection: true },
    { field: 'email', headerName: 'Email', width: 250, editable: true, cellEditor: EmailEditorComponent },
    { field: 'country', headerName: 'Country', width: 150, filter: 'agSetColumnFilter' },
    {
      field: 'plan', headerName: 'Plan', width: 130, editable: true,
      cellEditor: 'agSelectCellEditor', cellEditorParams: { values: PLAN },
    },
    { field: 'status', headerName: 'Status', width: 120, cellRenderer: StatusRendererComponent },
    {
      field: 'responses', headerName: 'Responses', width: 130, editable: true, aggFunc: 'sum',
      cellEditor: 'agNumberCellEditor', filter: 'agNumberColumnFilter',
      valueParser: (p: any) => {
        const n = p.newValue === '' || p.newValue == null ? NaN : Number(p.newValue);
        return Number.isFinite(n) ? n : null;   // non-numbers (e.g. pasted text) become empty
      },
    },
    {
      field: 'completion', headerName: 'Completion', width: 140, filter: 'agNumberColumnFilter', aggFunc: 'avg',
      valueFormatter: (p: any) => (p.value == null ? '' : `${Math.round(p.value)}%`),
      cellStyle: (p: any) => (p.value < 40 ? { color: '#b3261e', fontWeight: '600' } : null),
    },
    { field: 'signedUp', headerName: 'Signed up', width: 140, filter: 'agDateColumnFilter', editable: true, cellEditor: 'agDateStringCellEditor' },
    { field: 'lastSeen', headerName: 'Last seen', width: 140 },
  ];

  sideBar = {
    toolPanels: [
      { id: 'columns', labelDefault: 'Columns', toolPanel: 'agColumnsToolPanel' },
      { id: 'filters', labelDefault: 'Filters', toolPanel: 'agFiltersToolPanel' },
    ],
    defaultToolPanel: '',
  };

  statusBar = {
    statusPanels: [
      { statusPanel: 'agTotalRowCountComponent' },
      { statusPanel: 'agAggregationComponent' },
    ],
  };

  constructor() { this.setRows(1000); }

  getRowId = (p: { data: DemoRow }) => String(p.data.id);

  getContextMenuItems = () => ['copy', 'copyWithHeaders', 'separator', 'csvExport', 'excelExport'];

  setRows(n: number): void {
    const rows = new Array<DemoRow>(n);
    for (let i = 0; i < n; i++) {
      const first = FIRST[i % FIRST.length];
      const last = LAST[(i * 7) % LAST.length];
      rows[i] = {
        id: i + 1,
        name: `${first} ${last}`,
        email: `${first}.${last}`.toLowerCase() + `${i}@example.com`,
        country: COUNTRY[(i * 3) % COUNTRY.length],
        plan: PLAN[(i * 5) % PLAN.length],
        status: i % 4 === 0 ? 'invited' : 'active',
        responses: (i * 37) % 5000,
        completion: (i * 13) % 101,
        signedUp: `2026-0${(i % 9) + 1}-1${i % 10}`,
        lastSeen: `2026-0${(i % 8) + 1}-2${i % 8}`,
      };
    }
    this.rowData = rows;
  }

  onPagination(e: PaginationChangedEvent): void {
    if (!this.api) return;
    this.log(`paginationChanged page ${this.api.paginationGetCurrentPage() + 1}/${this.api.paginationGetTotalPages()}`
      + `${e.newPage ? ' newPage' : ''}${e.newData ? ' newData' : ''}${e.newPageSize ? ' newPageSize' : ''}`);
  }

  onReady(e: GridReadyEvent): void { this.api = e.api; this.log('gridReady'); }

  onQuickFilter(): void { this.api?.setQuickFilter(this.quickFilter); }

  exportCsv(): void { this.api?.exportDataAsCsv({ fileName: 'bs-grid-demo.csv' }); }

  exportExcel(): void { this.api?.exportDataAsExcel({ fileName: 'bs-grid-demo.xlsx' }); }

  groupBy(field: string | null): void {
    this.api?.applyColumnState({
      state: this.columnDefs.map(c => ({ colId: c.field, rowGroup: c.field === field })),
    });
  }

  autoSize(): void { this.api?.autoSizeAllColumns(); }

  resetColumns(): void { this.api?.resetColumnState(); }

  onSelectionChanged(): void {
    this.selectedCount = this.api?.getSelectedRows().length ?? 0;
    this.log(`selectionChanged (${this.selectedCount})`);
  }

  log(msg: string): void {
    this.events = [`${new Date().toLocaleTimeString()} ${msg}`, ...this.events].slice(0, 8);
  }
}
