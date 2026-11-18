import type { EvidenceSubmission, EvidenceValidationContext, LocatedEvidenceFragment, ValidationIssue } from '@t1/contracts';
import { buildSourceEvidenceUnits, classifySourceSpan, sourceUnitMissingSpans } from './source-evidence-units.js';
import { verbatimOmissionIssues } from './verbatim-policy.js';
import { tableStructureStatus, checkedSourceGrid, checkedTableSourceContains } from './document-structure-context.js';
import { sameSourceParagraph } from './paragraph-units.js';
import { resolveTableSupportCells, tableDescriptionSpans, tableValueContexts, sourceText, TABLE_SUPPORT_POLICY_VERSION } from './table-support.js';

export const VISUAL_STATEMENT_POLICY_VERSION = 'visual-statements-2' as const;
type Document = EvidenceValidationContext['document'];
export interface LocatedTableSupport { table_id: string; reference_evidence: LocatedEvidenceFragment[]; fragments: LocatedEvidenceFragment[];
  context_fragments?: LocatedEvidenceFragment[]; selected_cell_ids?: string[]; description_evidence?: LocatedEvidenceFragment[];
  value_contexts?: Array<{ cell_id: string; row_start: number; row_end: number; col_start: number; col_end: number; mapping_status: string;
    fragments: LocatedEvidenceFragment[]; context_fragments: LocatedEvidenceFragment[] }> }
const contains = (a: LocatedEvidenceFragment, b: LocatedEvidenceFragment) => a.block_id === b.block_id && a.text_version === b.text_version && a.start <= b.start && a.end >= b.end;
const overlaps = (a: LocatedEvidenceFragment, b: LocatedEvidenceFragment) => a.block_id === b.block_id && a.start < b.end && b.start < a.end;
const tableMarkers = (value: string) => [...value.matchAll(/\bTable\s*(\d+)\b|表\s*([0-9０-９]+)/giu)]
  .map(m => (m[1] ?? m[2])!.replace(/[０-９]/gu, c => String(c.charCodeAt(0) - 0xff10)));

/** Only mechanical evidence roles, source spans and explicit table identities are hard checks.
 * Neither a model's label nor these lexical checks establish medical visual semantics. */
export function visualStatementIssues(document: Document, submission: Pick<EvidenceSubmission, 'evidence_type'>, source: LocatedEvidenceFragment[],
  context: LocatedEvidenceFragment[], fieldEvidence: LocatedEvidenceFragment[], support: LocatedTableSupport[], sourceGlyphPolicyVersion?: string, tableSupportPolicyVersion?: string, inputOrganizationVersion?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (code: string, severity: ValidationIssue['severity'], path: string, detail: string) => {
    if (!issues.some(i => i.code === code && i.path === path)) issues.push({ code, severity, path, detail });
  };
  for (const f of source) if (['table', 'table_caption'].includes(classifySourceSpan(document, f))) {
    add('table_evidence_cannot_be_primary', 'reject', 'source_fragments',
      'Primary evidence must be a visual source statement in prose/caption; explicitly cited table values belong only in supporting_table_evidence.');
  }
  const units = buildSourceEvidenceUnits(document, sourceGlyphPolicyVersion), uncertain: LocatedEvidenceFragment[] = [];
  for (const u of units.filter(u => u.segments.some(s => source.some(f => overlaps(s, f))))) {
    if (u.completeness === 'complete') {
      const missing = sourceUnitMissingSpans(u, source);
      if (missing.some(s => {
        const b = document.blocks.find(b => b.block_id === s.block_id)!;
        return Array.from(b.text).slice(s.start, s.end).join('').trim();
      })) add('incomplete_source_statement', 'reject', 'source_fragments',
        'Select the complete original sentence, including preceding/following source spans: ' + JSON.stringify(missing));
    } else {
      uncertain.push(...source.filter(f => u.segments.some(s => overlaps(s, f))));
      add('source_statement_boundary_requires_review', 'requires_review', 'source_fragments',
        'The source sentence/paragraph boundary cannot be established safely; do not merge columns, pages, native units or case identities.');
    }
  }
  // Known complete sentence spans already preserve every character. Unmapped/uncertain
  // boundaries retain the historical whole-line qualifier/number guard.
  for (const issue of verbatimOmissionIssues(document, uncertain)) add(issue.code, issue.severity, issue.path, issue.detail);
  for (const u of units.filter(u => u.completeness === 'complete' && u.segments.some(s => context.some(f => overlaps(s, f))))) {
    const missing = sourceUnitMissingSpans(u, [...source, ...context]);
    if (missing.some(s => Array.from(document.blocks.find(b => b.block_id === s.block_id)!.text).slice(s.start, s.end).join('').trim())) {
      add('incomplete_context_statement', 'reject', 'context_fragments', 'Necessary context must retain its complete known source statement: ' + JSON.stringify(missing));
    }
  }

  for (const [index, s] of support.entries()) {
    const path = `supporting_table_evidence[${index}]`;
    const table = document.schema_version === '3' ? document.structure.tables.find(t => t.table_id === s.table_id) : undefined;
    if (!table) { add('supporting_table_not_found', 'reject', path, 'No table with this ID exists in the bound source version.'); continue; }
    if (tableStructureStatus(document, table).support_semantics === 'blocked_due_to_structure_conflict') {
      add('supporting_table_structure_conflict', 'reject', path,
        'Native cell/header relationships conflict with decoded source structure. Values may still be literal; a value/feature support relationship cannot use this grid until repaired.');
    }
    const activeGrid = checkedSourceGrid(document, table), sourceTitle = activeGrid?.caption_status === 'geometry_checked_numbered_title' ? activeGrid.caption_segments : undefined;
    if (table.association_status === 'conflict' && !sourceTitle?.length) add('supporting_table_caption_conflict', 'reject', path, 'The table/caption association is explicitly conflicted.');
    const sameParagraphReference = tableSupportPolicyVersion === TABLE_SUPPORT_POLICY_VERSION &&
      s.reference_evidence.every(f => [...source, ...context].some(p => contains(p, f))) && sameSourceParagraph(document, source, s.reference_evidence, inputOrganizationVersion);
    if (!s.reference_evidence.length || !s.reference_evidence.every(f => source.some(p => contains(p, f))) && !sameParagraphReference) {
      add('supporting_table_reference_not_in_primary', 'reject', path, 'The literal table reference must belong to the primary visual statement.');
    }
    const captionUnits = document.schema_version === '3' ? document.structure.units.filter(u => table.caption_unit_ids.includes(u.unit_id) &&
      ['exact', 'normalized_alignment'].includes(u.mapping.status)) : [];
    const caption = (sourceTitle ?? captionUnits.flatMap(u => u.source_segments)).map(s => {
      const b = document.blocks.find(b => b.block_id === s.block_id);
      return b ? Array.from(b.text).slice(s.start, s.end).join('') : '';
    }).join('\n');
    const numbers = [...new Set(tableMarkers(caption))], references = tableMarkers(s.reference_evidence.map(f => f.exact_quote).join('\n'));
    if (numbers.length !== 1 || !references.includes(numbers[0]!)) add('supporting_table_explicit_reference_required', 'reject', path,
      'An exact numbered table reference in the primary statement must match a uniquely mapped table caption.');
    const tableUnitIds = new Set([table.table_id, ...table.cells.map(c => c.unit_id)]);
    const tableUnits = document.schema_version === '3' ? document.structure.units.filter(u => tableUnitIds.has(u.unit_id) &&
      ['exact', 'normalized_alignment'].includes(u.mapping.status)) : [];
    if (!s.fragments.length || !s.fragments.every(f => checkedSourceGrid(document, table) ? checkedTableSourceContains(document, table, f) :
      tableUnits.some(u => u.source_segments.some(p => p.block_id === f.block_id && p.text_version === f.text_version && p.start <= f.start && p.end >= f.end)))) {
      add('supporting_table_value_source_mismatch', 'reject', path, 'Supporting values must be exact mapped source spans of the named table.');
    }
    if (!s.fragments.some(f => /[0-9０-９]/u.test(f.exact_quote))) add('supporting_table_numeric_value_required', 'reject', path, 'Attach literal values, not an independent table feature-name list.');
    if (tableSupportPolicyVersion === TABLE_SUPPORT_POLICY_VERSION) {
      try {
        const resolved = resolveTableSupportCells(document, s.table_id, s.selected_cell_ids ?? []);
        if (!resolved.value_spans.every(span => s.fragments.some(f => contains(f, { ...span } as LocatedEvidenceFragment))) ||
          !s.fragments.every(f => resolved.value_spans.some(span => contains({ ...span } as LocatedEvidenceFragment, f)))) add('supporting_table_selected_value_mismatch', 'reject', path, 'The exact selected cells, rather than another group or a whole independent column, must supply the values.');
        const supportingContext = s.context_fragments ?? [];
        if (resolved.context_spans.some(span => sourceText(document, [span]).trim() && ![...s.fragments, ...supportingContext].some(f => contains(f, { ...span } as LocatedEvidenceFragment)))) {
          add('supporting_table_row_column_unit_footnote_context_required', 'reject', path, 'Retain the selected cells\' metric/row-group, column headers/units, table identity and available footnotes.');
        }
        if (supportingContext.some(f => !resolved.context_spans.some(span => contains({ ...span } as LocatedEvidenceFragment, f)))) add('supporting_table_context_source_mismatch', 'reject', path, 'Context must belong to the selected values\' source row/column/title/footnotes.');
        const ids = (text: string) => [...text.matchAll(/\b(?:case|patient|lesion)\s*(?:no\.?\s*)?\d+\b|(?:病例|患者|病灶)\s*\d+/giu)].map(m => m[0].replace(/\s+/g, '').toLowerCase());
        const descriptions = tableDescriptionSpans(document, source, s.reference_evidence, inputOrganizationVersion);
        if (!descriptions.length) add('supporting_table_primary_description_binding_required', 'reject', path, 'A bare citation cannot stand in for an actual primary source description in that paragraph.');
        const mainText = sourceText(document, descriptions) + '\n' + s.reference_evidence.map(f => f.exact_quote).join('\n');
        const modalities = (text: string) => [...new Set(text.match(/\b(?:CT|MRI|PET|US)\b/gu) ?? [])];
        const main = ids(mainText), stated = modalities(mainText), values = tableValueContexts(document, s.table_id, s.selected_cell_ids ?? []);
        for (const cell of values) {
          const cellPath = `${path}.cell[${cell.cell_id}]`, selectedText = sourceText(document, [...cell.value_spans, ...cell.context_spans]);
          const selected = ids(selectedText), cellConditions = modalities(selectedText);
          if (main.length && selected.some(id => !main.includes(id))) add('supporting_table_explicit_subject_conflict', 'reject', cellPath, 'An explicitly different numbered case/patient cannot supply this value.');
          if (stated.length && cellConditions.some(value => !stated.includes(value))) add('supporting_table_explicit_condition_conflict', 'reject', cellPath, 'Explicit source and selected-row modality labels conflict for this value.');
        }
        if (s.value_contexts) {
          const sameSpans = (actual: LocatedEvidenceFragment[], expected: typeof resolved.value_spans) => expected.every(span => actual.some(f => contains(f, { ...span } as LocatedEvidenceFragment))) && actual.every(f => expected.some(span => contains({ ...span } as LocatedEvidenceFragment, f)));
          if (s.value_contexts.length !== values.length || values.some(value => {
            const saved = s.value_contexts!.filter(v => v.cell_id === value.cell_id);
            return saved.length !== 1 || saved[0]!.row_start !== value.row_start || saved[0]!.row_end !== value.row_end || saved[0]!.col_start !== value.col_start || saved[0]!.col_end !== value.col_end || saved[0]!.mapping_status !== value.mapping_status ||
              !sameSpans(saved[0]!.fragments, value.value_spans) || !sameSpans(saved[0]!.context_fragments, value.context_spans);
          })) add('supporting_table_per_value_context_mismatch', 'reject', path, 'Each persisted value must keep its own bound source cell and exact row/column context.');
          if (!s.description_evidence || !sameSpans(s.description_evidence, descriptions)) add('supporting_table_description_binding_mismatch', 'reject', path, 'Persisted support must identify the actual source description fragments it supplements.');
        }
      } catch (error) { add(error instanceof Error ? error.message : 'supporting_table_cell_selection_failed', 'reject', path, 'Select known source cells with their required context; unresolved values must not be invented.'); }
    }
    add('supporting_table_value_relationship_requires_review', tableSupportPolicyVersion === TABLE_SUPPORT_POLICY_VERSION ? 'info' : 'requires_review', path,
      'The numbered reference and literal table values are located; the semantic value/feature relationship remains unverified.');
  }
  const supporting = support.flatMap(s => [...s.fragments, ...(s.context_fragments ?? [])]);
  for (const f of [...context, ...fieldEvidence]) if (['table', 'table_caption'].includes(classifySourceSpan(document, f)) && !supporting.some(s => contains(s, f))) {
    add('table_context_requires_explicit_support', 'reject', 'context_fragments', 'Table text/values cannot be attached through context or fields without explicit supporting_table_evidence.');
  }
  if (['feature_mention', 'association_conclusion'].includes(submission.evidence_type)) add('visual_statement_purpose_requires_review', 'requires_review', 'evidence_type',
    'A feature-name list, statistical association or study conclusion alone is not a visual description. Source semantics require review; a declared evidence type does not prove them.');
  add('visual_description_semantics_unverified', 'info', 'source_fragments',
    'Mechanical checks do not establish visual-description meaning, terminology, case attribution or medical pairing.');
  return issues;
}
