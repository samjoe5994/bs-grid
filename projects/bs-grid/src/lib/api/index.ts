// Public API barrel for BsGrid — the single import surface app code should use in place of the
// former ag-grid-community / ag-grid-angular imports (ColDef, GridApi, GridReadyEvent,
// ICellRendererAngularComp, ICellEditorParams, …). Kept separate from public-types.ts so the
// GridApi re-export doesn't create a cycle (grid-api.ts imports ColDef from public-types).
export * from './public-types';
export { GridApi } from './grid-api';
