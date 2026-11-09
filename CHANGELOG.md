# Changelog

## 0.1.1 (2026-11-09)

- Published from GitHub Actions through npm trusted publishing, with provenance. No code changes.

## 0.1.0 (2026-11-08)

First extraction of BsGrid from the BlockSurvey app into a standalone library, synced with the app's grid as of 2026-10-05.

### Features
- Standalone `BsGridComponent` plus `BsGridModule` shell for NgModule apps
- Curated public API: `ColDef`, `GridOptions`, `GridApi`, event types, cell renderer/editor contracts, `Column`, `RowNode`, `CellRange`, `ExportParams`, `ExcelMultipleSheetParams`, `RangeAggregation`
- Real `.xlsx` Excel export through a built-in zip writer (multi-sheet, frozen panes, AG-compatible Excel API)
- Status-bar aggregation (Sum / Average / Min / Max / Count) over the selected cells
- Edge auto-scroll while drag-selecting a range, and a range drag that always ends
- Clipboard paste (`Ctrl/Cmd+V`) into ranges, with `processCellFromClipboard`, `pasteStart` and `pasteEnd`
- Pagination matching AG Grid's client-side behaviour: panel with page-size dropdown, `paginationAutoPageSize`, `suppressPaginationPanel`, `paginationChanged`, and the full `pagination*` API
- Responsive pinning (AG v31+): pinned columns that leave under 50 px of center are unpinned automatically on resize or pin, with `processUnpinnedColumns` to customise; pinned resize is capped the same way
- `enterNavigatesVerticallyAfterEdit` and `colDef.suppressKeyboardEvent`
- AG-style horizontal scrollbar under the center columns only
- Dropdown cell editors can open blank instead of auto-picking the first option
- Theme tokens `--bs-grid-bg`, `--bs-grid-text-muted`, `--bs-grid-row-active`, `--bs-grid-group-bg`, `--bs-grid-control-border`, `--bs-grid-overlay-bg`; no hardcoded surface colors, so a full dark theme works
- Optional dark theme at `styles/bs-grid-dark.css`
- Zero runtime dependencies beyond Angular peer deps and `tslib`

### Fixes
- A fast drag-and-release selected only the anchor cell: the last pointer move was dropped when release landed in the same frame
- Fill-down, Delete and Ctrl+Enter bulk edits updated the data but left the old values on screen
- The status-bar aggregation kept summing old values after a cell edit
- Auto-size measured with a system font instead of the grid's font and ignored the selection checkbox, so autosized columns clipped their text
- `autoSizeAllColumns()` now fires `columnResized`
- Enter after an edit opened an editor on the next row; it now keeps focus on the edited cell, as AG Grid does. Escape after an edit now returns keyboard focus to the grid
- Editing a cell re-sorted and re-filtered the grid, so the edited row jumped away; edits now only re-aggregate, matching AG Grid
- `rowNode.setDataValue` only refreshed the grid for nodes obtained through `getRowNode`; every node now refreshes, including group totals
- Enter / Escape / Tab didn't reach the grid from custom editor components
- At narrow widths the status bar pushed its first items off the left edge; it now wraps
