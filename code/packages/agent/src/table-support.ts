import { ContractError, type EvidenceFragment } from '@t1/contracts';
import type { ExtractionDocument } from './article-scope.js';
import { checkedSourceGrid, tableStructureStatus } from './document-structure-context.js';
import { buildSourceParagraphs, buildSourceContentUnits, CONTENT_ORGANIZATION_VERSION } from './paragraph-units.js';
import type { SourceSpan } from './source-evidence-units.js';

export const TABLE_SUPPORT_POLICY_VERSION = 'paragraph-linked-table-support-2' as const;
type Cell = { id: string; row_start: number; row_end: number; col_start: number; col_end: number; header: boolean; rowHeader: boolean;
  spans: SourceSpan[]; header_ids: string[]; row_group_id: string | null };
export const sourceText = (document: ExtractionDocument, spans: readonly SourceSpan[]) => spans.map(s => Array.from(document.blocks.find(b => b.block_id === s.block_id)!.text).slice(s.start, s.end).join('')).join('\n');
const markers = (text: string) => [...text.matchAll(/\bTable\s*(\d+)\b|表\s*([0-9０-９]+)/giu)].map(m => (m[1] ?? m[2])!.replace(/[０-９]/gu, c => String(c.charCodeAt(0) - 0xff10)));
const contains = (a: SourceSpan, b: SourceSpan) => a.block_id === b.block_id && a.text_version === b.text_version && a.start <= b.start && a.end >= b.end;

/** Bind a support to actual primary fragments in the reference's paragraph.
 * Other independent primary fragments are preserved, but cannot supply this
 * table's case/condition labels. A bare table citation supplies no description. */
export function tableDescriptionSpans(document: ExtractionDocument, primary: readonly SourceSpan[], references: readonly SourceSpan[], inputOrganizationVersion?: string) {
  if (!references.length) return [];
  const citationOnly = (text: string) => /^(?:(?:see(?:\s+also)?|cf\.?|见|参见)\s*)?(?:Table\s*\d+|表\s*[0-9０-９]+)[\s\p{P}\p{S}]*$/iu.test(text.trim());
  const parents = inputOrganizationVersion === CONTENT_ORGANIZATION_VERSION ? buildSourceContentUnits(document) : buildSourceParagraphs(document);
  return parents.filter(p => ['native_paragraph', 'checked_continuation', 'checked_native_column_continuation'].includes(p.basis) && ['paragraph', 'caption'].includes(p.kind) &&
    references.every(s => p.source_spans.some(t => contains(t, s)))).flatMap(p => primary.filter(s => p.source_spans.some(t => contains(t, s)) && !citationOnly(sourceText(document, [s]))));
}

export function tableSourceCells(document: ExtractionDocument, tableId: string) {
  if (document.schema_version !== '3') throw new ContractError('supporting_table_not_found');
  const table = document.structure.tables.find(t => t.table_id === tableId);
  if (!table) throw new ContractError('supporting_table_not_found');
  if (tableStructureStatus(document, table).support_semantics === 'blocked_due_to_structure_conflict' || table.association_status === 'conflict' && !checkedSourceGrid(document, table)) throw new ContractError('supporting_table_structure_conflict');
  const byId = new Map(document.structure.units.map(u => [u.unit_id, u])), grid = checkedSourceGrid(document, table);
  const reliableSpans = (ids: string[]) => ids.flatMap(id => { const u = byId.get(id); return u && ['exact', 'normalized_alignment'].includes(u.mapping.status) ? u.source_segments : []; });
  const cells: Cell[] = grid ? grid.cells.map(c => ({ id: c.cell_id, row_start: c.row_start, row_end: c.row_end, col_start: c.col_start, col_end: c.col_end,
    header: c.role === 'column_header', rowHeader: c.role === 'row_group_label', spans: c.source_segments,
    header_ids: c.column_header_ids, row_group_id: c.row_group_cell_id })) : table.cells.map(c => ({ id: c.unit_id, row_start: c.row_start, row_end: c.row_end,
      col_start: c.col_start, col_end: c.col_end, header: c.column_header, rowHeader: c.row_header || c.row_section, spans: reliableSpans([c.unit_id]), header_ids: [], row_group_id: null }));
  const caption = grid?.caption_status === 'geometry_checked_numbered_title' ? grid.caption_segments : reliableSpans(table.caption_unit_ids);
  const numbers = [...new Set(markers(sourceText(document, caption)))];
  return { table, cells, caption, number: numbers.length === 1 ? numbers[0]! : null,
    footnotes: grid ? grid.footnote_segments : reliableSpans(table.footnote_unit_ids), geometry_checked: Boolean(grid) };
}

export function resolveTableSupportCells(document: ExtractionDocument, tableId: string, cellIds: readonly string[]) {
  const source = tableSourceCells(document, tableId), selected = cellIds.map(id => source.cells.find(c => c.id === id));
  if (!selected.length || selected.some(c => !c || c.header || c.rowHeader || !c.spans.length || !/[0-9０-９]/u.test(sourceText(document, c.spans)))) throw new ContractError('supporting_table_numeric_cell_selection_required');
  const values = selected as Cell[], related = source.cells.filter(c => !values.includes(c) && values.some(v =>
    v.header_ids.includes(c.id) || v.row_group_id === c.id || c.header && c.col_start < v.col_end && v.col_start < c.col_end ||
    c.row_start < v.row_end && v.row_start < c.row_end && (c.rowHeader || c.col_start === 0 || !/[0-9０-９]/u.test(sourceText(document, c.spans)))));
  return { ...source, selected: values, value_spans: values.flatMap(c => c.spans), condition_spans: related.flatMap(c => c.spans),
    context_spans: [...source.caption, ...related.flatMap(c => c.spans), ...source.footnotes] };
}

/** Per-value row/column links are host-owned source structure, not a model's
 * paraphrase or a semantic approval. Shared titles/footnotes stay on the support. */
export function tableValueContexts(document: ExtractionDocument, tableId: string, cellIds: readonly string[]) {
  return cellIds.map(cell_id => {
    const resolved = resolveTableSupportCells(document, tableId, [cell_id]), cell = resolved.selected[0]!;
    return { cell_id, row_start: cell.row_start, row_end: cell.row_end, col_start: cell.col_start, col_end: cell.col_end,
      mapping_status: resolved.geometry_checked ? 'source_geometry_checked_semantics_unapproved' as const : 'native_mapping_unapproved' as const,
      value_spans: resolved.value_spans, context_spans: resolved.condition_spans };
  });
}

/** Only source-span evidence is returned. Row/column metadata preserves its
 * checked/native status; it does not prove a medical value-feature match. */
export function readReferencedTable(document: ExtractionDocument, tableId: string, referenceSpans: SourceSpan[], primarySpans: SourceSpan[],
  selection: { cell_ids?: string[]; row_indices?: number[] }, authorized: ReadonlySet<string>, inputOrganizationVersion?: string) {
  const source = tableSourceCells(document, tableId), referenceNumbers = markers(sourceText(document, referenceSpans));
  const description_spans = tableDescriptionSpans(document, primarySpans, referenceSpans, inputOrganizationVersion);
  if (!source.number || !referenceNumbers.includes(source.number) || !description_spans.length) throw new ContractError('supporting_table_same_paragraph_reference_required');
  const ids = selection.cell_ids?.length ? selection.cell_ids : source.cells.filter(c => !c.header && !c.rowHeader && selection.row_indices?.some(row => c.row_start <= row && row < c.row_end) && /[0-9０-９]/u.test(sourceText(document, c.spans))).map(c => c.id);
  const resolved = resolveTableSupportCells(document, tableId, ids);
  const spans = [...resolved.value_spans, ...resolved.context_spans, ...resolved.caption];
  if (spans.some(s => !authorized.has(s.block_id))) throw new ContractError('supporting_table_source_outside_task_scope');
  return { ...resolved, description_spans, requested_cell_ids: ids, block_ids: [...new Set(spans.map(s => s.block_id))] };
}

/** Source offsets remain host owned; model fields receive exact original
 * strings plus the occurrence needed to recover the same immutable span. */
export function fragmentsForSourceSpans(document: ExtractionDocument, spans: readonly SourceSpan[]): EvidenceFragment[] {
  return spans.map(span => {
    const block = document.blocks.find(b => b.block_id === span.block_id), cps = Array.from(block?.text ?? '');
    if (!block || span.text_version !== document.text_version || span.start < 0 || span.end > cps.length || span.start >= span.end) throw new ContractError('supporting_table_source_span_invalid');
    const quote = cps.slice(span.start, span.end), matches: number[] = [];
    for (let i = 0; i <= cps.length - quote.length; i++) if (quote.every((c, j) => cps[i + j] === c)) matches.push(i);
    return { block_id: span.block_id, exact_quote: quote.join(''), occurrence: matches.indexOf(span.start) };
  });
}
