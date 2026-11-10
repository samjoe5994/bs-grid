# ngx-bs-grid

[![npm version](https://img.shields.io/npm/v/ngx-bs-grid.svg)](https://www.npmjs.com/package/ngx-bs-grid)
[![npm downloads](https://img.shields.io/npm/dm/ngx-bs-grid.svg)](https://www.npmjs.com/package/ngx-bs-grid)
[![CI](https://github.com/samjoe5994/bs-grid/actions/workflows/ci.yml/badge.svg)](https://github.com/samjoe5994/bs-grid/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/ngx-bs-grid.svg)](https://github.com/samjoe5994/bs-grid/blob/main/LICENSE)

**[Live demo](https://samjoe5994.github.io/bs-grid/)** · **[GitHub](https://github.com/samjoe5994/bs-grid)** · **[Changelog](https://github.com/samjoe5994/bs-grid/blob/main/CHANGELOG.md)** · **[Report an issue](https://github.com/samjoe5994/bs-grid/issues)**

A lightweight Angular data grid with **zero runtime dependencies**. It needs nothing beyond Angular and RxJS.

Built at [BlockSurvey](https://blocksurvey.io) to replace AG Grid on production screens rendering tens of thousands of survey responses. The `@Input`/`@Output` and `GridApi` surface deliberately mirrors AG Grid's, so migrating an existing grid is mostly a rename.

MIT licensed. No license key, no watermark, no enterprise tier.

## Features

- Row and column virtualization — only the visible window is in the DOM
- Column pinning (left/right), resize, reorder, hide/show, auto-size, flex sizing
- Sorting, per-column filters, quick filter, external filter hook
- Row selection (single/multiple, checkbox) and **range/cell selection** with copy, paste, fill-down, bulk edit and delete, plus edge auto-scroll while dragging
- Paste from Excel / Google Sheets (tab-separated, quoted multi-line cells supported)
- Row grouping with `sum` / `avg` / `count` / `min` / `max` or custom aggregation
- Cell renderers and cell editors as regular Angular components (`agInit` / `refresh` contract), plus built-in text, number, date and select editors
- Sidebar tool panels (columns, filters) and a status bar with row counts and a live Sum / Average / Min / Max / Count of the selected cells
- CSV export and real `.xlsx` Excel export (multi-sheet, frozen panes), built in with no zip library
- Pagination with AG Grid's panel, page-size dropdown, auto page size and pagination API
- Keyboard navigation and ARIA roles
- SSR-safe — every browser API is guarded with `isPlatformBrowser`
- Themed entirely with CSS custom properties

## Install

```bash
npm install ngx-bs-grid
```

Peer deps: Angular 20, 21 or 22 (`@angular/core`, `@angular/common`, `@angular/forms`) and `rxjs` ^7.8.

| Angular | Status |
| --- | --- |
| 21 | Tested: production build, SSR prerender and hydration |
| 20 | Tested: SSR render |
| 22 | Allowed by the peer range, not tested yet |

## Migrating from AG Grid

Most screens move over by changing the imports and the tag. Column definitions, events and `GridApi` calls keep their AG Grid names.

| AG Grid | bs-grid |
| --- | --- |
| `<ag-grid-angular>` | `<bs-grid>` |
| `AgGridAngular` / `AgGridModule` | `BsGridComponent` (standalone) / `BsGridModule` |
| `ColDef`, `GridApi`, `GridReadyEvent` from `ag-grid-community` | the same names from `ngx-bs-grid` |
| `ICellRendererAngularComp`, `ICellEditorAngularComp` from `ag-grid-angular` | the same names from `ngx-bs-grid` |
| `agNumberColumnFilter`, `agDateColumnFilter`, `agSetColumnFilter`, `agSelectCellEditor`, `agNumberCellEditor`, … | the same string keys |

Check [Not yet supported](#not-yet-supported) before you migrate a screen that uses Enterprise-only row models.

## Quickstart

Standalone component:

```ts
import { Component } from '@angular/core';
import { BsGridComponent, ColDef, GridApi, GridReadyEvent } from 'ngx-bs-grid';

@Component({
  selector: 'app-people',
  imports: [BsGridComponent],
  template: `
    <div style="height: 500px">
      <bs-grid
        [rowData]="rows"
        [columnDefs]="cols"
        [defaultColDef]="{ sortable: true, filter: true, resizable: true }"
        [rowSelection]="'multiple'"
        [enableRangeSelection]="true"
        (gridReady)="onReady($event)"
        (cellValueChanged)="onEdit($event)">
      </bs-grid>
    </div>
  `,
})
export class PeopleComponent {
  private api!: GridApi;

  cols: ColDef[] = [
    { field: 'name', headerName: 'Name', pinned: 'left', width: 180 },
    { field: 'email', headerName: 'Email', flex: 1 },
    { field: 'score', headerName: 'Score', editable: true, width: 120 },
  ];

  rows = [
    { name: 'Ada Lovelace', email: 'ada@example.com', score: 98 },
    { name: 'Alan Turing', email: 'alan@example.com', score: 95 },
  ];

  onReady(e: GridReadyEvent) { this.api = e.api; this.api.sizeColumnsToFit(); }
  onEdit(e: any) { console.log(e.oldValue, '→', e.newValue); }
}
```

NgModule app:

```ts
import { BsGridModule } from 'ngx-bs-grid';

@NgModule({ imports: [BsGridModule] })
export class FeatureModule {}
```

### Sizing — read this first

The grid fills its parent. **Give it a bounded box** or the page grows instead of the grid scrolling internally:

```scss
.grid-wrapper { height: 500px; }            // or flex: 1 1 0%; min-height: 0;
```

Inside flex layouts: every row-flex ancestor needs `min-width: 0`, every column-flex ancestor needs `flex: 1 1 0%; min-height: 0`. Bootstrap `.col-*` wrappers need `h-100`.

## Column definitions

`ColDef` fields:

`colId`, `field`, `headerName`, `headerTooltip`, `width`, `minWidth`, `maxWidth`, `flex`, `resizable`, `suppressSizeToFit`, `suppressAutoSize`, `pinned`, `lockPinned`, `lockPosition`, `suppressMovable`, `hide`, `sortable`, `sort`, `sortIndex`, `sortingOrder`, `comparator`, `filter`, `filterParams`, `floatingFilter`, `filterValueGetter`, `valueGetter`, `valueFormatter`, `valueParser`, `valueSetter`, `cellRenderer`, `cellRendererParams`, `cellRendererSelector`, `cellEditor`, `cellEditorParams`, `cellEditorPopup`, `cellEditorSelector`, `editable`, `cellStyle`, `cellClass`, `cellClassRules`, `tooltipField`, `tooltipValueGetter`, `checkboxSelection`, `headerCheckboxSelection`, `headerCheckboxSelectionFilteredOnly`, `autoHeight`, `wrapText`, `cellDataType`.

## Cell renderer

Any Angular component implementing `ICellRendererAngularComp`:

```ts
import { Component } from '@angular/core';
import { ICellRendererAngularComp, BsCellParams } from 'ngx-bs-grid';

@Component({ template: `<span class="badge">{{ value }}</span>` })
export class BadgeRenderer implements ICellRendererAngularComp {
  value = '';
  agInit(params: BsCellParams) { this.value = params.value; }
  refresh(params: BsCellParams) { this.value = params.value; return true; }
}
```

```ts
{ field: 'status', cellRenderer: BadgeRenderer }
```

Returning `false` from `refresh()` recreates the component; `true` keeps it (the fast path).

## GridApi

Handed to you in `(gridReady)`. Selected methods:

| Area | Methods |
|---|---|
| Columns | `getColumnState`, `applyColumnState`, `resetColumnState`, `setColumnDefs`, `setColumnVisible`, `setColumnsVisible`, `sizeColumnsToFit`, `autoSizeColumns`, `autoSizeAllColumns` |
| Filtering | `getFilterModel`, `setFilterModel`, `setQuickFilter`, `isAnyFilterPresent`, `onFilterChanged` |
| Selection | `getSelectedNodes`, `getSelectedRows`, `selectAll`, `deselectAll`, `setNodesSelected` |
| Ranges | `getCellRanges`, `addCellRange`, `clearCellSelection` |
| Rows | `getRowNode`, `forEachNode`, `forEachNodeAfterFilterAndSort`, `getDisplayedRowCount`, `getDisplayedRowAtIndex`, `applyTransaction`, `refreshCells`, `redrawRows` |
| Viewport | `ensureIndexVisible`, `ensureColumnVisible`, `setFocusedCell`, `getFocusedCell` |
| Pagination | `paginationGetCurrentPage`, `paginationGetTotalPages`, `paginationGetPageSize`, `paginationGetRowCount`, `paginationGoToPage`, `paginationGoToNextPage`, `paginationGoToPreviousPage`, `paginationGoToFirstPage`, `paginationGoToLastPage`, `paginationSetPageSize`, `paginationIsLastPageFound` |
| Export | `exportDataAsCsv`, `getDataAsCsv`, `exportDataAsExcel`, `getDataAsExcel`, `exportMultipleSheetsAsExcel`, `getMultipleSheetsAsExcel`, `getSheetDataForExcel` |
| Options | `setGridOption`, `getGridOption` |

## Events

`gridReady`, `firstDataRendered`, `selectionChanged`, `rowSelected`, `rowClicked`, `rowDoubleClicked`, `cellClicked`, `cellDoubleClicked`, `cellValueChanged`, `cellEditingStarted`, `cellContextMenu`, `cellFocused`, `cellSelectionChanged`, `cellSelectionDeleteStart`, `cellSelectionDeleteEnd`, `pasteStart`, `pasteEnd`, `paginationChanged`, `filterChanged`, `sortChanged`, `columnPinned`, `columnMoved`, `columnResized`, `columnVisible`.

## Editing

Editing works like AG Grid: after a value changes (typed, pasted, filled down or set with `rowNode.setDataValue`), group totals are recalculated but rows are **not** re-sorted or re-filtered, so the row stays where the user is looking. The next sort, filter or data change puts it in place. `setDataValue` works on any row node, including ones from `forEachNode` or events. Custom editors receive Enter / Escape / Tab from the grid; return `true` from `colDef.suppressKeyboardEvent` to keep a key inside your editor.

## Clipboard

- **Copy** (`Ctrl/Cmd+C`) writes the selected range as tab-separated text, so it pastes straight into a spreadsheet. Shape each value with `[processCellForClipboard]`.
- **Paste** (`Ctrl/Cmd+V`) needs `[enableRangeSelection]="true"`. A block is written from the top-left of the selection (or the focused cell); a single value fills every cell of a multi-cell selection. Only `editable` cells change. Each value passes through `[processCellFromClipboard]`, then the column's `valueParser`, and fires `cellValueChanged`. The pasted block is selected afterwards.

## Pagination

```html
<bs-grid [rowData]="rows" [columnDefs]="cols"
  [pagination]="true"
  [paginationPageSize]="50"
  [paginationPageSizeSelector]="[25, 50, 100]"
  (paginationChanged)="onPage($event)">
</bs-grid>
```

| Input | Default | Notes |
|---|---|---|
| `pagination` | `false` | Turns paging on. |
| `paginationPageSize` | `100` | Rows per page. |
| `paginationPageSizeSelector` | `true` | Page-size dropdown. `true` offers 20 / 50 / 100, an array sets the sizes, `false` hides it. The current size is always listed. |
| `paginationAutoPageSize` | `false` | Fits exactly as many rows as the grid's height holds, and hides the dropdown. |
| `suppressPaginationPanel` | `false` | Hides the panel so you can build your own controls on the API. |

It behaves like AG Grid's client-side pagination:
- Page numbers in the API are zero-based. Row indexes stay global (row 45 is row 45 on any page).
- Sorting, filtering and data updates keep the current page, clamped to the new page count. Turning pagination off returns to page 1.
- Changing the page size keeps the page number, clamped.
- Keyboard navigation, range selection and paste stay inside the current page. ↑ on the page's first row moves to the header, and Tab past the page's last cell leaves the grid.
- `ensureIndexVisible(i)` jumps to the row's page only when the panel is suppressed. With the panel shown, the user's page choice is left alone.
- Select-all in the header selects every row, not just the page.

## Responsive behaviour

The grid fills whatever box you give it and reflows when that box changes size (it watches its own size, not the window):
- Rows and columns are virtualized, so a phone renders only what fits.
- **Pinned columns that don't fit are unpinned automatically**, as in AG Grid v31+. When left + right pinned columns would leave less than 50 px of scrollable center, columns are unpinned (right side first, then left, alternating, skipping `lockPinned`) until it fits. They are not re-pinned when the grid grows again; re-apply your saved column state if you want them back. Customise or turn this off with `[processUnpinnedColumns]` (return `[]` to keep every pin).
- Dragging a pinned column wider stops 50 px before the center would disappear.
- The status bar and pagination panel wrap onto extra lines on narrow screens.
- Header menus, the context menu and filter popups stay inside the grid.
- `paginationAutoPageSize` recomputes the page size whenever the grid's height changes.
- Give `flex` columns a `minWidth` (for example `{ field: 'name', flex: 1, minWidth: 160 }`). On a narrow screen a flex column shrinks to its `minWidth` (default 40 px) and the grid scrolls sideways, the same as AG Grid.

## Status bar

```ts
statusBar = { statusPanels: [
  { statusPanel: 'agTotalRowCountComponent' },
  { statusPanel: 'agAggregationComponent' },   // Sum / Average / Min / Max / Count of selected cells
] };
```

## Keyboard

| Keys | Action |
|---|---|
| Arrows | move focused cell |
| Shift + Arrows | extend range selection |
| Tab / Shift+Tab | next / previous cell |
| Enter, F2 | start editing |
| Escape | cancel edit |
| Home / End, PageUp / PageDown | jump within the viewport |
| Ctrl/Cmd + C | copy selected range |
| Ctrl/Cmd + V | paste into the selection |
| Ctrl/Cmd + D | fill down |
| Enter (while editing) | save and keep focus on the cell (`enterNavigatesVerticallyAfterEdit` moves focus down) |
| Escape (while editing) | cancel and keep focus on the cell |
| Ctrl/Cmd + Enter (while editing) | apply the value to every cell in the selection |
| Space | select / deselect the focused row |
| Delete | clear selected range |

## Theming

Override any token on the `bs-grid` element:

```css
bs-grid {
  --bs-grid-border: #e5e7eb;
  --bs-grid-border-strong: #d1d5db;
  --bs-grid-header-bg: #f9fafb;
  --bs-grid-header-text: #111827;
  --bs-grid-text: #374151;
  --bs-grid-row-hover: #f3f4f6;
  --bs-grid-selected: #eef2ff;
  --bs-grid-pinned-bg: #fcfcfd;
  --bs-grid-accent: #4f46e5;
  --bs-grid-accent-strong: #4338ca;
  --bs-grid-accent-soft: #eef2ff;
  --bs-grid-font: 13px/1.4 system-ui, sans-serif;
  --bs-grid-bg: #ffffff;                 /* rows, panels, menus, editors */
  --bs-grid-text-muted: #7f8c8d;         /* secondary chrome text */
  --bs-grid-row-active: #f2f6fd;         /* last-clicked row */
  --bs-grid-group-bg: #f6f8fa;           /* row-group header rows */
  --bs-grid-control-border: #a0a8ae;     /* checkbox outlines */
  --bs-grid-overlay-bg: rgba(255, 255, 255, 0.7);  /* loading scrim */
}
```

A dark theme ships with the package:

```json
"styles": ["node_modules/ngx-bs-grid/styles/bs-grid-dark.css"]
```

then put `class="bs-grid-dark"` on any ancestor.

## Server-side rendering

Works with zoneless and zone-based Angular SSR with no configuration. On the server the grid renders its shell (header row, row slots, status bar); cell content is filled in on the client once the viewport has a real width, since column virtualization needs it. Your own cell renderers must guard their own browser API access.

## Not yet supported

Compared with AG Grid Enterprise: the server-side and infinite row models, pivot charts / integrated charts, master-detail rows, tree data, and undo/redo. Issues and PRs welcome.

## License

MIT © BlockSurvey
