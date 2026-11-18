import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { StructureUnit } from '@t1/contracts';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { buildArticleScope } from '../../packages/agent/src/article-scope.js';
import { buildSourceContentUnits, buildSourceParagraphs, planParagraphBatches, CONTENT_ORGANIZATION_VERSION } from '../../packages/agent/src/paragraph-units.js';
import { buildSourceEvidenceUnits } from '../../packages/agent/src/source-evidence-units.js';
import { expandBatchLineEvidence } from '../../packages/agent/src/extraction-protocol.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { buildEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { tableDescriptionSpans, readReferencedTable } from '../../packages/agent/src/table-support.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';
type Fixture = ReturnType<typeof makeEvidenceFixture>;
const glyph = 'agent-assesses-parsed-glyphs-1' as const;
const span = (f: Fixture, i: number) => ({ block_id: f.document.blocks[i]!.block_id, text_version: f.document.text_version, start: 0, end: Array.from(f.document.blocks[i]!.text).length });
function mapped(f: Fixture, indices: number[], kind: StructureUnit['kind'] = 'text', id = 'native-paragraph') {
  const u: StructureUnit = { unit_id: id, native_ref: '#/' + id, kind, native_label: kind, content_layer: 'body',
    native_text: indices.map(i => f.document.blocks[i]!.text).join(' '), native_original_text: null, native_text_role: 'processed_native_not_literal_quote',
    source_segments: indices.map(i => span(f, i)), provenance: [], mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_4',
      matched_native_code_points: 1, alignable_native_code_points: 1, transformations: [], warnings: [] } };
  f.document.structure.units.push(u); f.document.structure.reading_order.push(id); return u;
}
function picture(f: Fixture, id = 'native-picture') {
  const u = mapped(f, [], 'picture', id); u.mapping.status = 'not_text';
  u.provenance = [{ physical_page: 1, bbox: [0, 0, 600, 800], coordinate_system: 'crop_rotated_top_left_pt', native_ref: '#/picture',
    native_bbox: {}, native_page_size: [600, 800], native_charspan: [0, 0], precision: 'native_element_bbox' }]; return u;
}
function columnFixture(table = false) {
  const f = makeEvidenceFixture(table ? ['CT shows a round nodule.', 'The source lists dimensions in', 'the referenced Table 2, with', 'the original groups and units.',
    'Table 2 Diameter', 'Diameter (mm)', '4.2 ± 1.1'] : ['The source describes a lesion with', 'a stable size in', 'the next column, preserving its', 'original context and qualifiers.']);
  [[10, 600, 260, 610], [10, 612, 260, 622], [310, 100, 560, 110], [310, 112, 560, 122]].forEach((box, i) => { f.document.blocks[i]!.bbox = box; });
  const u = mapped(f, [0, 1, 2, 3]), leftEnd = f.document.blocks.slice(0, 2).map(b => b.text).join(' ').length;
  u.provenance = [[10, 600, 260, 622], [310, 100, 560, 122]].map((bbox, i) => ({ physical_page: 1, bbox, coordinate_system: 'crop_rotated_top_left_pt',
    native_ref: u.native_ref, native_bbox: {}, native_page_size: [600, 800], native_charspan: i ? [leftEnd + 1, u.native_text.length] : [0, leftEnd], precision: 'native_element_bbox' }));
  u.source_regions = [[0, 1], [2, 3]].map((indices, i) => ({ provenance_index: i, source_segments: indices.map(i => span(f, i)), mapping_status: 'exact' }));
  if (table) {
    mapped(f, [4], 'caption', 'caption'); mapped(f, [5], 'table_cell', 'header'); mapped(f, [6], 'table_cell', 'value');
    f.document.structure.tables.push({ table_id: 'table-2', native_ref: '#/table', physical_pages: [1], caption_unit_ids: ['caption'], footnote_unit_ids: [], association_basis: 'native_explicit',
      n_rows: 2, n_cols: 1, cells: ['header', 'value'].map((unit_id, i) => ({ unit_id, row_start: i, row_end: i + 1, col_start: 0, col_end: 1,
        row_span: 1, col_span: 1, column_header: i === 0, row_header: false, row_section: false })), native_html: null, cross_page_continuation: 'not_assumed' });
  }
  return f;
}
function graphFixture(n = 5) { const f = makeEvidenceFixture(Array.from({ length: n }, (_, i) => `Label ${i}`));
  f.document.blocks.forEach((_, i) => mapped(f, [i], 'text', 'label-' + i)); picture(f); return f; }

test('v2 groups figure labels as independent members and preserves reliable prose, captions, headings and tables', () => {
  const f = makeEvidenceFixture(['Axis', '0 50 100', 'CT shows a round', 'nodule with unchanged margins.', 'A complete one-line source sentence.',
    'A caption.', 'A heading', '4.2 mm']);
  mapped(f, [0], 'text', 'axis'); mapped(f, [1], 'text', 'ticks'); mapped(f, [2, 3]); mapped(f, [4], 'text', 'sentence');
  mapped(f, [5], 'caption', 'caption'); mapped(f, [6], 'section_header', 'heading'); mapped(f, [7], 'table_cell', 'cell'); picture(f);
  f.document.structure.tables.push({ table_id: 'table', native_ref: '#/table', physical_pages: [1], caption_unit_ids: [], footnote_unit_ids: [], association_basis: 'none', n_rows: 1, n_cols: 1,
    cells: [{ unit_id: 'cell', row_start: 0, row_end: 1, col_start: 0, col_end: 1, row_span: 1, col_span: 1, column_header: false, row_header: false, row_section: false }], native_html: null, cross_page_continuation: 'not_assumed' });
  const before = JSON.stringify(f.document), old = buildSourceParagraphs(f.document), current = buildSourceContentUnits(f.document, glyph);
  const graph = current.find(u => u.kind === 'figure_text')!; assert.equal(graph.member_units!.length, 2); assert.deepEqual(graph.block_ids, f.document.blocks.slice(0, 2).map(b => b.block_id));
  assert.equal(current.filter(u => u.kind === 'paragraph').length, 2); assert.ok(current.some(u => u.kind === 'caption')); assert.ok(current.some(u => u.kind === 'heading')); assert.ok(current.some(u => u.kind === 'table_row'));
  assert.equal(old.filter(u => u.kind === 'figure_text').length, 0, 'legacy v1 grouping is immutable');
  const plan = planParagraphBatches(f.document, buildArticleScope(f.document), { organizationVersion: CONTENT_ORGANIZATION_VERSION, sourceGlyphPolicyVersion: glyph });
  assert.equal(new Set(plan.batches.flatMap(b => b.assigned_block_ids)).size, f.document.blocks.length); assert.equal(JSON.stringify(f.document), before);
});

test('an overlapping or ambiguous picture region never guesses ownership or swallows body prose', () => {
  const f = graphFixture(); picture(f, 'overlapping-picture');
  assert.equal(buildSourceContentUnits(f.document, glyph).some(u => u.kind === 'figure_text'), false);
  assert.equal(buildSourceContentUnits(f.document, glyph).length, 5);
});

test('checked same-native same-page column continuation supplies one complete input paragraph with exact original spans', () => {
  const f = columnFixture(), before = JSON.stringify(f.document), old = buildSourceParagraphs(f.document), current = buildSourceContentUnits(f.document, glyph);
  assert.equal(old.length, 2); assert.equal(current.length, 1); assert.equal(current[0]!.basis, 'checked_native_column_continuation');
  assert.deepEqual(current[0]!.source_spans, f.document.blocks.map((_, i) => span(f, i))); assert.equal(JSON.stringify(f.document), before);
});

for (const reason of ['page', 'line-height', 'terminal', 'indent', 'native-gap', 'case', 'caption'] as const) test(`column continuation keeps ${reason} boundary conservative`, () => {
  const f = columnFixture(), u = f.document.structure.units[0]!;
  if (reason === 'page') { u.provenance[1]!.physical_page = 2; f.document.blocks[2]!.page = 2; f.document.blocks[3]!.page = 2; }
  if (reason === 'line-height') for (const b of f.document.blocks.slice(2)) b.bbox[3] = b.bbox[1]! + 6;
  if (reason === 'terminal') f.document.blocks[1]!.text += '.';
  if (reason === 'indent') f.document.blocks[2]!.bbox[0] = 340;
  if (reason === 'native-gap') { const end = u.provenance[0]!.native_charspan![1]!; u.native_text = u.native_text.slice(0, end) + ' DIFFERENT PARAGRAPH ' + u.native_text.slice(end); u.provenance[1]!.native_charspan![0]! += 20; }
  if (reason === 'case') { f.document.blocks[0]!.text = 'Case 1 starts'; f.document.blocks[2]!.text = 'Case 2 ends'; }
  if (reason === 'caption') mapped(f, [2, 3], 'caption', 'explicit-caption');
  assert.equal(buildSourceContentUnits(f.document, glyph).some(p => p.basis === 'checked_native_column_continuation'), false);
});

test('v2 table binding follows a proved same-native column continuation while v1 and unrelated groups remain conservative', () => {
  const f = columnFixture(true), refs = [span(f, 2)], source = [span(f, 0)];
  assert.equal(tableDescriptionSpans(f.document, source, refs).length, 0); assert.equal(tableDescriptionSpans(f.document, source, refs, CONTENT_ORGANIZATION_VERSION).length, 1);
  const units = buildSourceEvidenceUnits(f.document, glyph), primary = units.find(u => u.segments[0]!.block_id === f.document.blocks[0]!.block_id)!;
  const submission = expandBatchLineEvidence({ source_unit_ids: [primary.unit_id], context_line_indices: [1, 2, 3], supporting_table_evidence: [{ table_id: 'table-2', reference_line_indices: [2], cell_ids: ['value'] }],
    feature_name_raw: null, feature_category: 'synthetic', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors' }, f.document.blocks, f.submission.binding, units, f.document);
  const context = { ...f.context, evidencePolicyVersion: 'visual-statements-2' as const, sourceGlyphPolicyVersion: glyph, tableSupportPolicyVersion: 'paragraph-linked-table-support-2' as const };
  assert.equal(validateEvidenceSubmission(submission, context).accepted, false);
  const valid = validateEvidenceSubmission(submission, { ...context, inputOrganizationVersion: CONTENT_ORGANIZATION_VERSION });
  assert.equal(valid.accepted, true, JSON.stringify(valid.issues)); assert.equal(valid.record!.extraction_trace.input_organization_version, CONTENT_ORGANIZATION_VERSION);
  assert.equal(buildEvidenceDelivery(f.document, [{ record: valid.record!, version: 1, actor: 'automatic' }]).records[0]!.supporting_table_evidence![0]!.value_contexts![0]!.fragments[0]!.exact_quote, '4.2 ± 1.1');
  readReferencedTable(f.document, 'table-2', refs, source, { cell_ids: ['value'] }, new Set(f.document.blocks.map(b => b.block_id)), CONTENT_ORGANIZATION_VERSION);
  const saved = structuredClone(valid.record!); delete saved.extraction_trace.input_organization_version;
  assert.throws(() => buildEvidenceDelivery(f.document, [{ record: saved, version: 1, actor: 'automatic' }]), /delivery_visual_statement_policy_failed/);
  const graph = graphFixture(); assert.equal(tableDescriptionSpans(graph.document, [span(graph, 0)], [span(graph, 1)], CONTENT_ORGANIZATION_VERSION).length, 0);
});

test('v2 glyph-bearing single-line description keeps its explicit table support and original string through delivery', () => {
  const f = makeEvidenceFixture(['CT shows a round 5 m\u0001m nodule (Table 2).', 'Table 2 Diameter', 'Diameter (mm)', '4.2']);
  mapped(f, [0]); mapped(f, [1], 'caption', 'caption'); mapped(f, [2], 'table_cell', 'header'); mapped(f, [3], 'table_cell', 'value');
  f.document.blocks[0]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 0, end: 1, font_name: 'Synthetic', font_program_sha256: 'a'.repeat(64), pdf_character_code: 1, precision: 'glyph_offset' }];
  f.document.parser.status = 'partial';
  f.document.structure.tables.push({ table_id: 'table-2', native_ref: '#/table', physical_pages: [1], caption_unit_ids: ['caption'], footnote_unit_ids: [], association_basis: 'native_explicit', n_rows: 2, n_cols: 1,
    cells: ['header', 'value'].map((unit_id, i) => ({ unit_id, row_start: i, row_end: i + 1, col_start: 0, col_end: 1, row_span: 1, col_span: 1, column_header: i === 0, row_header: false, row_section: false })), native_html: null, cross_page_continuation: 'not_assumed' });
  assert.equal(buildSourceEvidenceUnits(f.document)[0]!.completeness, 'unverified', 'legacy glyph diagnostic remains');
  assert.equal(buildSourceEvidenceUnits(f.document)[0]!.kind, 'sentence', 'mechanical source sentence boundary is unchanged');
  assert.equal(buildSourceContentUnits(f.document).find(p => p.block_ids.includes(f.document.blocks[0]!.block_id))!.kind, 'paragraph');
  const units = buildSourceEvidenceUnits(f.document, glyph), submission = expandBatchLineEvidence({ source_unit_ids: [units[0]!.unit_id], supporting_table_evidence: [{ table_id: 'table-2', reference_line_indices: [0], cell_ids: ['value'] }],
    feature_name_raw: null, feature_category: 'synthetic', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors' }, f.document.blocks, f.submission.binding, units, f.document);
  const valid = validateEvidenceSubmission(submission, { ...f.context, evidencePolicyVersion: 'visual-statements-2', sourceGlyphPolicyVersion: glyph,
    inputOrganizationVersion: CONTENT_ORGANIZATION_VERSION, tableSupportPolicyVersion: 'paragraph-linked-table-support-2' });
  assert.equal(valid.accepted, true, JSON.stringify(valid.issues)); const delivery = buildEvidenceDelivery(f.document, [{ record: valid.record!, version: 1, actor: 'automatic' }]);
  assert.equal(delivery.records[0]!.original_fragments[0]!.exact_quote, f.document.blocks[0]!.text);
  assert.equal(delivery.records[0]!.supporting_table_evidence![0]!.value_contexts![0]!.fragments[0]!.exact_quote, '4.2');
});

for (const failLast of [false, true]) test(`installed SDK v2 figure parts retain parent/member context and only complete the group after every part (${failLast ? 'failure' : 'success'})`, async () => {
  const f = graphFixture(); f.document.blocks[0]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 0, end: 1, font_name: 'Synthetic', font_program_sha256: 'a'.repeat(64), pdf_character_code: 1, precision: 'glyph_offset' }]; f.document.parser.status = 'partial';
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/content-sdk-')), store = new ExtractionStore(':memory:'); let batches = 0;
  const server = await createRuntimeResponsesFixture(() => {
    if (store.snapshot(f.input.run_id).state === 'extracting') { if (failLast && batches >= 2) return { status: 400 }; batches++; return { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] }; }
    return { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: { summary: 'Synthetic input organization receipt only.', reviews: [], links: [], updates: [], summary_complete: true } }] };
  });
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
      config: server.config, profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), store, directory: resolve(directory, 'run'), strategy: 'baseline',
      sourceGlyphPolicyVersion: glyph, inputOrganization: 'paragraphs', inputOrganizationVersion: CONTENT_ORGANIZATION_VERSION, batchOptions: { maxBlocks: 2, contextBlocks: 0 }, prefillBatchSource: true, stopOnBatchFailure: true });
    assert.equal(result.coverage.progress_unit, 'content_units'); assert.equal(result.coverage.dispatched_content_units, 1); assert.equal(result.coverage.dispatched_processing_units, 3);
    assert.deepEqual(result.coverage.input_unit_counts, { figure_text: 1 }); assert.equal(result.coverage.explicitly_completed_content_units, failLast ? 0 : 1); assert.equal(result.task_processing_complete, !failLast);
    const receipts = result.events.filter(e => e.type === 'batch').map(e => e.detail as any);
    assert.deepEqual(receipts[0].completed_content_unit_ids, []); assert.deepEqual(receipts[1].completed_content_unit_ids, []);
    const prompt = JSON.stringify(server.requests[0]!.body); for (const field of ['figure_text', 'member_units', 'parent_content_unit_id', 'source_members_are_independent', 'fragment_count']) assert.ok(prompt.includes(field), field);
    assert.ok(prompt.includes('Label 0')); assert.equal(result.medical_quality_approved, false);
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
