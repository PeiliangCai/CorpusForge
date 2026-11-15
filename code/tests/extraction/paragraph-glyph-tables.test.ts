import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import type { StructureUnit, EvidenceValidationContext } from '@t1/contracts';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { buildArticleScope } from '../../packages/agent/src/article-scope.js';
import { buildSourceParagraphs, planParagraphBatches, sameSourceParagraph } from '../../packages/agent/src/paragraph-units.js';
import { SOURCE_GLYPH_INPUT_POLICY_VERSION as glyphPolicy } from '../../packages/agent/src/source-glyph-policy.js';
import { TABLE_SUPPORT_POLICY_VERSION as tablePolicy, readReferencedTable, resolveTableSupportCells } from '../../packages/agent/src/table-support.js';
import { selectSourceBlocks, taskSourceBlockIds } from '../../packages/agent/src/source-selection.js';
import { buildSourceEvidenceUnits } from '../../packages/agent/src/source-evidence-units.js';
import { validateEvidenceSubmission } from '../../packages/agent/src/evidence-validation.js';
import { expandBatchLineEvidence, type StatementEvidence } from '../../packages/agent/src/extraction-protocol.js';
import { buildEvidenceDelivery, exportEvidenceDelivery } from '../../packages/agent/src/evidence-delivery.js';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionTools } from '../../packages/agent/src/extraction-tools.js';
import { ExtractionSummaryTools } from '../../packages/agent/src/extraction-summary.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';

type Fixture = ReturnType<typeof makeEvidenceFixture>;
function native(f: Fixture, indices: number[], kind: StructureUnit['kind'] = 'text', id = 'paragraph') {
  const unit: StructureUnit = { unit_id: id, native_ref: '#/test/' + id, kind, native_label: kind,
    native_text: 'Not an authoritative quotation.', native_original_text: null, native_text_role: 'processed_native_not_literal_quote', content_layer: 'body',
    source_segments: indices.map(i => span(f, i)), provenance: [], mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_4',
      matched_native_code_points: 1, alignable_native_code_points: 1, transformations: [], warnings: [] } };
  f.document.structure.units.push(unit); f.document.structure.reading_order.push(id); return unit;
}
const span = (f: Fixture, i: number) => ({ block_id: f.document.blocks[i]!.block_id, text_version: f.document.text_version, start: 0, end: Array.from(f.document.blocks[i]!.text).length });
const policyContext = (f: Fixture): EvidenceValidationContext => ({ ...f.context, evidencePolicyVersion: 'visual-statements-2', sourceGlyphPolicyVersion: glyphPolicy, tableSupportPolicyVersion: tablePolicy });
const candidate = (extra: Partial<StatementEvidence> = {}): StatementEvidence => ({ feature_name_raw: null, feature_category: 'synthetic-only', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors', ...extra });
function issueGlyph(f: Fixture, index = 0) { f.document.blocks[index]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 0, end: 1,
  font_name: 'Synthetic', font_program_sha256: 'a'.repeat(64), pdf_character_code: 1, precision: 'glyph_offset' }]; f.document.parser.status = 'partial'; }
async function sourceFile(f: Fixture, directory: string) {
  const path = resolve(directory, 'synthetic-source.json'); await writeFile(path, JSON.stringify(f.document.blocks.map(b => ({ text: b.text, page: b.page }))));
  f.document.source.file_reference = relative(process.cwd(), path);
}
function tableFixture() {
  const f = makeEvidenceFixture(['Case 1 on CT shows round nodules in groups Alpha and Beta.', 'Their corresponding diameters are in Table 2.',
    'Unrelated source context.', 'Table 2 CT nodule diameter by group', 'Group / case / modality', 'Diameter (mm)',
    'Case 1 CT Group A', '4.2 ± 1.1', 'Case 1 CT Group B', '5.5 ± 1.2', 'Case 2 MRI Group C', '8.8 ± 2.0', '* Values are mean ± SD; measured in mm.']);
  native(f, [0, 1]); native(f, [2], 'text', 'unrelated'); native(f, [3], 'caption', 'table-caption');
  const cells = [4, 5, 6, 7, 8, 9, 10, 11].map((index, n) => { const id = 'cell-' + n; native(f, [index], 'table_cell', id);
    return { unit_id: id, row_start: Math.floor(n / 2), row_end: Math.floor(n / 2) + 1, col_start: n % 2, col_end: n % 2 + 1,
      row_span: 1, col_span: 1, column_header: n < 2, row_header: n >= 2 && n % 2 === 0, row_section: false }; });
  native(f, [12], 'footnote', 'table-note');
  f.document.structure.tables.push({ table_id: 'table-2', native_ref: '#/tables/0', physical_pages: [1], caption_unit_ids: ['table-caption'],
    footnote_unit_ids: ['table-note'], association_basis: 'native_explicit', n_rows: 4, n_cols: 2, cells,
    native_html: null, cross_page_continuation: 'not_assumed', association_status: 'native_unverified' });
  return f;
}
function tableSubmission(f: Fixture, cells = ['cell-3', 'cell-5']) {
  const units = buildSourceEvidenceUnits(f.document, glyphPolicy);
  return expandBatchLineEvidence(candidate({ source_unit_ids: [units.find(u => u.segments[0]?.block_id === f.document.blocks[0]!.block_id)!.unit_id],
    context_line_indices: [1], supporting_table_evidence: [{ table_id: 'table-2', reference_line_indices: [1], cell_ids: cells }] }), f.document.blocks, f.submission.binding, units, f.document);
}
function sourceSentence(f: Fixture, text: string) {
  const b = f.document.blocks[0]!; b.text = text; b.raw_text = text; b.backend_text = text;
  b.normalization_map = [{ raw_start: 0, raw_end: Array.from(text).length, normalized_start: 0, normalized_end: Array.from(text).length, kind: 'identity' }];
  f.document.structure.units.find(u => u.unit_id === 'paragraph')!.source_segments[0] = span(f, 0);
}

test('paragraph input preserves every original line/offset and separate heading, caption, table structure', () => {
  const f = tableFixture(), before = JSON.stringify(f.document), article = buildArticleScope(f.document);
  const plan = planParagraphBatches(f.document, article, { sourceGlyphPolicyVersion: glyphPolicy });
  const first = plan.paragraphs.find(p => p.block_ids.includes(f.document.blocks[0]!.block_id))!;
  assert.equal(first.kind, 'paragraph'); assert.deepEqual(first.block_ids, f.document.blocks.slice(0, 2).map(b => b.block_id));
  assert.ok(plan.paragraphs.some(p => p.kind === 'caption')); assert.ok(plan.paragraphs.some(p => p.kind === 'table_row'));
  assert.equal(new Set(plan.batches.flatMap(b => b.assigned_block_ids)).size, article.included_block_ids.length);
  for (const unit of plan.processing_units) for (const s of unit.source_spans) assert.equal(s.text_version, f.document.text_version);
  assert.equal(JSON.stringify(f.document), before); assert.ok(plan.batches.every(b => b.assigned_block_ids.length <= 128 && b.source_code_points <= 8500));
});

test('unknown columns/pages, explicit different cases and partial native mapping conservatively fall back without joining', () => {
  for (const mode of ['column', 'page', 'case', 'partial'] as const) {
    const f = makeEvidenceFixture(mode === 'case' ? ['Case 1 has a round', 'Case 2 has a different nodule.'] : ['A source paragraph starts', 'and ends here.']);
    const u = native(f, [0, 1]);
    if (mode === 'column') f.document.blocks[1]!.bbox = [510, 40, 590, 55];
    if (mode === 'page') f.document.blocks[1]!.page = 2;
    if (mode === 'partial') u.source_segments[0]!.start = 2;
    const plan = buildSourceParagraphs(f.document);
    assert.equal(plan.length, 2, mode); assert.ok(plan.every(p => p.block_ids.length === 1), mode);
    assert.equal(sameSourceParagraph(f.document, [span(f, 0)], [span(f, 1)]), false, mode);
  }
});

test('long paragraph splits at complete sentences with one parent and exact coverage within existing bounds', () => {
  const f = makeEvidenceFixture(Array.from({ length: 5 }, (_, i) => `Sentence ${i} has a complete source statement.`)); native(f, [0, 1, 2, 3, 4]);
  const p = planParagraphBatches(f.document, buildArticleScope(f.document), { maxBlocks: 2, contextBlocks: 0, sourceGlyphPolicyVersion: glyphPolicy });
  assert.equal(p.paragraphs.length, 1); assert.equal(p.processing_units.length, 3); assert.equal(p.batches.length, 3);
  assert.ok(p.processing_units.every(u => u.paragraph_id === p.paragraphs[0]!.paragraph_id && u.fragment_count === 3));
  assert.deepEqual(p.processing_units.flatMap(u => u.source_spans), f.document.blocks.map((_, i) => span(f, i)));
  const impossible = makeEvidenceFixture(['x'.repeat(8600) + '.']); native(impossible, [0]);
  assert.throws(() => planParagraphBatches(impossible.document, buildArticleScope(impossible.document)), /source_statement_exceeds_batch_limits/);
});

test('new glyph policy includes suspect parsed strings in B0/read/summary; legacy policy and source bytes stay unchanged', async () => {
  const f = makeEvidenceFixture(['CT shows a 5 m\u0001m nodule.', 'A neighboring complete source statement.']); native(f, [0, 1]); issueGlyph(f);
  const before = JSON.stringify(f.document), article = buildArticleScope(f.document);
  assert.deepEqual(selectSourceBlocks(f.document, article, 'B0', { sourceGlyphPolicyVersion: glyphPolicy }).kept_block_ids, article.included_block_ids);
  assert.ok(!taskSourceBlockIds(f.document, article).includes(f.document.blocks[0]!.block_id));
  const batch = planParagraphBatches(f.document, article, { sourceGlyphPolicyVersion: glyphPolicy }).batches[0]!, store = new ExtractionStore(':memory:');
  store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  try {
    const tools = new ExtractionTools(policyContext(f), batch, article, store), result = await tools.invoke('read_document_blocks', tools.ids, 'read') as any;
    assert.equal(result.blocks[0].text, f.document.blocks[0]!.text); assert.equal(tools.completed, false);
    store.transition(f.input.run_id, 'reconciling');
    const summary = new ExtractionSummaryTools(policyContext(f), article, store, 'baseline');
    const reread = await summary.invoke('read_document_blocks', { run_id: f.input.run_id, document_id: f.document.document_id, block_ids: [f.document.blocks[0]!.block_id] }, 'summary-read');
    assert.ok(JSON.stringify(reread).includes('5 m\\u0001m')); assert.equal(summary.completed, false);
    assert.equal(JSON.stringify(f.document), before);
  } finally { store.close(); }
});

test('new glyph quotes deliver and retained-export verbatim without a human gate, while rewritten characters/binding reject', async () => {
  const f = makeEvidenceFixture(['CT shows a 5 m\u0001m nodule.']); native(f, [0]); issueGlyph(f);
  const submission = expandBatchLineEvidence(candidate({ source_unit_ids: [buildSourceEvidenceUnits(f.document, glyphPolicy)[0]!.unit_id] }), f.document.blocks, f.submission.binding, buildSourceEvidenceUnits(f.document, glyphPolicy), f.document);
  const validated = validateEvidenceSubmission(submission, policyContext(f)); assert.equal(validated.accepted, true, JSON.stringify(validated.issues));
  const versions = [{ record: validated.record!, version: 1, actor: 'automatic' as const }], d = buildEvidenceDelivery(f.document, versions);
  assert.equal(d.records[0]!.original_fragments[0]!.exact_quote, f.document.blocks[0]!.text); assert.equal(d.source_glyph_check!.source_page_review_still_required, false);
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/paragraph-glyph-export-'));
  try {
    await sourceFile(f, directory);
    await exportEvidenceDelivery(f.document, versions, { codeRoot: '.', directory: resolve(directory, 'export'), mode: 'retained', coverage: {},
      retentionSelections: [{ record_id: validated.record!.record_id, record_version: 1, status: 'kept', revision: 0, origin: 'default', decision_record_version: 1 }] });
    const saved = JSON.parse(await readFile(resolve(directory, 'export/records.jsonl'), 'utf8')); assert.equal(saved.original_fragments[0].exact_quote, f.document.blocks[0]!.text);
    for (const mode of ['rewrite', 'binding'] as const) { const bad = structuredClone(submission); if (mode === 'rewrite') bad.source_fragments[0]!.exact_quote = bad.source_fragments[0]!.exact_quote.replace('\u0001', ''); else bad.binding.run_id = 'other-run';
      assert.equal(validateEvidenceSubmission(bad, policyContext(f)).accepted, false, mode); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('table value support accepts next-sentence same-paragraph reference and multiple groups, preserves units/footnotes', async () => {
  const f = tableFixture(), submission = tableSubmission(f), before = JSON.stringify(f.document.blocks);
  const result = validateEvidenceSubmission(submission, policyContext(f)); assert.equal(result.accepted, true, JSON.stringify(result.issues));
  assert.equal(result.record!.original_quote, f.document.blocks[0]!.text);
  const support = result.record!.context.supporting_table_evidence![0]!;
  assert.deepEqual(support.fragments.map(v => v.exact_quote), ['4.2 ± 1.1', '5.5 ± 1.2']);
  assert.equal(support.value_contexts!.length, 2);
  assert.equal(support.value_contexts![0]!.fragments[0]!.exact_quote, '4.2 ± 1.1');
  assert.ok(support.value_contexts![0]!.context_fragments.some(f => f.exact_quote === 'Case 1 CT Group A'));
  assert.ok(!support.value_contexts![0]!.context_fragments.some(f => f.exact_quote.includes('Group B')));
  assert.equal(support.value_contexts![1]!.fragments[0]!.exact_quote, '5.5 ± 1.2');
  assert.ok(support.value_contexts![1]!.context_fragments.some(f => f.exact_quote === 'Case 1 CT Group B'));
  assert.deepEqual(support.description_evidence!.map(f => f.exact_quote), [f.document.blocks[0]!.text]);
  const context = support.context_fragments!.map(f => f.exact_quote).join('\n');
  for (const text of ['Case 1 CT Group A', 'Case 1 CT Group B', 'Diameter (mm)', '* Values are mean ± SD']) assert.ok(context.includes(text), text);
  assert.equal(result.record!.evidence_validation.medical_semantics_verified, false);
  assert.ok(!result.issues.some(i => i.code === 'supporting_table_value_relationship_requires_review' && i.severity === 'requires_review'));
  const versions = [{ record: result.record!, version: 1, actor: 'automatic' as const }], directory = await mkdtemp(resolve('runtime-data/agent-notes/paragraph-table-export-'));
  try {
    await sourceFile(f, directory);
    await exportEvidenceDelivery(f.document, versions, { codeRoot: '.', directory: resolve(directory, 'export'), mode: 'candidates', coverage: {} });
    const saved = JSON.parse(await readFile(resolve(directory, 'export/table-support.jsonl'), 'utf8'));
    assert.equal(saved.role, 'supplement_to_original_description'); assert.equal(saved.record_id, result.record!.record_id);
    assert.equal(saved.value_contexts[1].fragments[0].exact_quote, '5.5 ± 1.2'); assert.ok(saved.value_contexts[1].context_fragments.some((f: any) => f.exact_quote.includes('Group B')));
    assert.ok((await readFile(resolve(directory, 'export/table-support.csv'), 'utf8')).includes('Diameter (mm)'));
    const csv = await readFile(resolve(directory, 'export/records.csv'), 'utf8');
    assert.ok(csv.includes('supporting_table_evidence_json') && csv.includes('4.2 ± 1.1'));
    assert.equal(csv.split('\n').filter(line => line.startsWith('"' + result.record!.record_id + '"')).length, 1, 'supplements do not become primary rows');
    assert.equal(JSON.stringify(f.document.blocks), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('each selected table value rejects an explicitly wrong subject/condition even beside a correct value', () => {
  const f = tableFixture(), bad = validateEvidenceSubmission(tableSubmission(f, ['cell-3', 'cell-7']), policyContext(f));
  assert.equal(bad.accepted, false); assert.ok(bad.issues.some(i => i.code === 'supporting_table_explicit_subject_conflict' && i.path?.includes('cell-7')));
  assert.ok(bad.issues.some(i => i.code === 'supporting_table_explicit_condition_conflict' && i.path?.includes('cell-7')));
  sourceSentence(f, 'Case 1 on CT and Case 2 on MRI show round nodules in their respective groups.');
  const good = validateEvidenceSubmission(tableSubmission(f, ['cell-3', 'cell-7']), policyContext(f));
  assert.equal(good.accepted, true, JSON.stringify(good.issues)); assert.equal(good.record!.context.supporting_table_evidence![0]!.value_contexts!.length, 2);
});

test('table support binds its actual primary paragraph while preserving other independent source fragments', () => {
  const f = tableFixture(), s = tableSubmission(f); s.source_fragments.push({ block_id: f.document.blocks[2]!.block_id, exact_quote: f.document.blocks[2]!.text });
  const valid = validateEvidenceSubmission(s, policyContext(f)); assert.equal(valid.accepted, true, JSON.stringify(valid.issues));
  assert.equal(valid.record!.quote_span.segments.length, 2); assert.equal(valid.record!.context.supporting_table_evidence![0]!.description_evidence!.length, 1);
  f.document.blocks[1]!.text = 'Table 2'; f.document.structure.units.find(u => u.unit_id === 'paragraph')!.source_segments[1] = span(f, 1);
  const citationOnly = tableSubmission(f); citationOnly.source_fragments = [f.document.blocks[1]!, f.document.blocks[2]!].map(b => ({ block_id: b.block_id, exact_quote: b.text }));
  const invalid = validateEvidenceSubmission(citationOnly, policyContext(f)); assert.equal(invalid.accepted, false);
  assert.ok(invalid.issues.some(i => i.code === 'supporting_table_primary_description_binding_required'));
});

test('delivery rejects tampered per-value context links instead of swapping group labels', () => {
  const f = tableFixture(), record = validateEvidenceSubmission(tableSubmission(f), policyContext(f)).record!;
  const values = record.context.supporting_table_evidence![0]!.value_contexts!;
  [values[0]!.context_fragments, values[1]!.context_fragments] = [values[1]!.context_fragments, values[0]!.context_fragments];
  assert.throws(() => buildEvidenceDelivery(f.document, [{ record, version: 1, actor: 'automatic' }]), /delivery_visual_statement_policy_failed/);
});

for (const mode of ['wrong-number', 'different-paragraph', 'wrong-case', 'wrong-condition', 'missing-unit', 'missing-footnote', 'unresolved-cell', 'standalone-column'] as const) test(`table support rejects ${mode} without guessing a replacement`, () => {
  const f = tableFixture();
  if (mode === 'wrong-number') f.document.blocks[1]!.text = 'Their corresponding diameters are in Table 3.';
  if (mode === 'different-paragraph') { f.document.structure.units[0]!.source_segments = [span(f, 0)]; native(f, [1], 'text', 'different-paragraph'); }
  if (mode === 'wrong-case') f.document.blocks[0]!.text = 'Case 9 on MRI shows round nodules.';
  if (mode === 'wrong-condition') f.document.blocks[0]!.text = 'Case 1 on MRI shows round nodules.';
  if (mode === 'unresolved-cell') { assert.throws(() => tableSubmission(f, ['does-not-exist']), /numeric_cell_selection_required/); return; }
  const s = tableSubmission(f);
  if (mode === 'missing-unit' || mode === 'missing-footnote') s.supporting_table_evidence![0]!.context_fragments = s.supporting_table_evidence![0]!.context_fragments!.filter(f => !f.exact_quote.includes(mode === 'missing-unit' ? 'Diameter (mm)' : 'mean ± SD'));
  if (mode === 'standalone-column') { s.source_fragments = s.supporting_table_evidence![0]!.value_fragments; s.supporting_table_evidence = []; s.context_fragments = []; }
  const result = validateEvidenceSubmission(s, policyContext(f)); assert.equal(result.accepted, false, JSON.stringify(result.issues));
  assert.ok(result.issues.some(i => i.severity === 'reject' && /table/u.test(i.code)), mode);
});

test('cross-batch table reread uses current same-paragraph reference and scope, stable indices, no completion receipt', async () => {
  const f = tableFixture(), article = buildArticleScope(f.document), store = new ExtractionStore(':memory:');
  store.create(f.input, f.context.metadata); store.transition(f.input.run_id, 'extracting');
  const batch = { ...planParagraphBatches(f.document, article, { sourceGlyphPolicyVersion: glyphPolicy }).batches[0]!, assigned_block_ids: f.document.blocks.slice(0, 2).map(b => b.block_id), context_block_ids: [] };
  const tools = new ExtractionTools(policyContext(f), batch, article, store, 'batch_lines'), read = tools.definitions().find(t => t.name === 'read_document_blocks')!;
  const context = {} as Parameters<typeof read.execute>[4];
  try {
    const invoke = (id: string, args: unknown) => read.execute(id, args, undefined, undefined, context);
    await assert.rejects(invoke('unread-table', { table_request: { table_id: 'table-2', reference_line_indices: [1], row_indices: [1] } }), /actual_source_read/);
    await invoke('primary', {});
    const result = JSON.parse((await invoke('table', { table_request: { table_id: 'table-2', reference_line_indices: [1], row_indices: [1, 2] } })).content.filter(c => c.type === 'text').map(c => c.text).join(''));
    assert.equal(result.requested_table.other_batch_completion_implied, false); assert.deepEqual(result.requested_table.selected_cell_ids, ['cell-3', 'cell-5']);
    assert.ok(result.source_lines.every((line: any) => line.line_index >= 2)); assert.equal(tools.completed, false); assert.equal(store.batches(f.input.run_id).length, 0);
    assert.ok(tools.readBlocks.has(f.document.blocks[7]!.block_id));
    const submit = tools.definitions().find(t => t.name === 'submit_candidate_records')!;
    const sourceUnit = buildSourceEvidenceUnits(f.document, glyphPolicy).find(u => u.segments[0]?.block_id === f.document.blocks[0]!.block_id)!;
    await submit.execute('supported-candidate', { records: [candidate({ source_unit_ids: [sourceUnit.unit_id], context_line_indices: [1],
      supporting_table_evidence: [{ table_id: 'table-2', reference_line_indices: [1], cell_ids: ['cell-3', 'cell-5'] }] })], batch_complete: true }, undefined, undefined, context);
    assert.equal(store.current(f.input.run_id).length, 1); assert.equal(tools.completed, true);
    assert.equal(store.batches(f.input.run_id).length, 0, 'tool completion is not a receipt for the separately assigned table batch');
    store.transition(f.input.run_id, 'reconciling');
    const summary = new ExtractionSummaryTools(policyContext(f), article, store, 'baseline');
    const inventory = await summary.invoke('get_document_context', { run_id: f.input.run_id, document_id: f.document.document_id }, 'summary-context') as any;
    assert.deepEqual(inventory.records[0].supporting_table_evidence[0].selected_cell_ids, ['cell-3', 'cell-5']);
    await summary.invoke('read_document_blocks', { run_id: f.input.run_id, document_id: f.document.document_id, block_ids: f.document.blocks.map(b => b.block_id) }, 'summary-support-read');
    const summaryDefs = summary.definitions(), summarySubmit = summaryDefs.find(t => t.name === 'submit_candidate_records')!;
    await summarySubmit.execute('summary-supported-update', { summary: 'Synthetic table evidence only.', reviews: [], links: [], updates: [candidate({ updates_record_id: store.current(f.input.run_id)[0]!.record.record_id,
      source_unit_ids: [sourceUnit.unit_id], context_line_indices: [1], supporting_table_evidence: [{ table_id: 'table-2', reference_line_indices: [1], cell_ids: ['cell-3', 'cell-5'] }] })], summary_complete: false }, undefined, undefined, context);
    assert.equal(summary.completed, false); assert.ok(store.versions(f.input.run_id).some(v => v.record.context.supporting_table_evidence?.[0]?.selected_cell_ids?.length === 2));
    assert.throws(() => readReferencedTable(f.document, 'table-2', [span(f, 1)], [span(f, 0)], { cell_ids: ['cell-3'] }, new Set(batch.assigned_block_ids)), /outside_task_scope/);
    await assert.rejects(invoke('mixed', { line_indices: [0], table_request: { table_id: 'table-2', reference_line_indices: [1], row_indices: [1] } }), /choose_table_request_or_source_lines/);
  } finally { store.close(); }
});

test('installed SDK loopback delivers a glyph-bearing candidate after automatic summary without changing the parsed string', async () => {
  const f = makeEvidenceFixture(['CT shows a 5 m\u0001m nodule.']); native(f, [0]); issueGlyph(f);
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/glyph-candidate-sdk-')), store = new ExtractionStore(':memory:');
  const server = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: { records: [candidate({ source_unit_ids: ['su-000001'] })], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: { summary: 'Synthetic receipt, not a medical finding.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ], { summaryAssessments: () => store.current(f.input.run_id).map(v => ({ record_id: v.record.record_id, expected_version: v.version, issue_codes: [], primary_assessment: 'uncertain' })) });
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
      config: server.config, profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), store,
      directory: resolve(directory, 'run'), strategy: 'baseline', inputOrganization: 'paragraphs', sourceGlyphPolicyVersion: glyphPolicy, tableSupportPolicyVersion: tablePolicy });
    assert.equal(result.candidate_count, 1); assert.equal(result.task_processing_complete, true); assert.equal(result.coverage.whole_document_summary_complete, true);
    const delivery = JSON.parse(await readFile(resolve(directory, 'run/delivery.json'), 'utf8'));
    assert.equal(result.coverage.delivery_validation_status, 'passed'); assert.equal(delivery.records[0]!.original_fragments[0]!.exact_quote, f.document.blocks[0]!.text);
    assert.equal(result.versions[0]!.record.extraction_trace.source_glyph_policy_version, glyphPolicy); assert.equal(result.medical_quality_approved, false);
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('installed SDK table reread, candidate and automatic summary preserve each values own source conditions', async () => {
  const f = tableFixture(), directory = await mkdtemp(resolve('runtime-data/agent-notes/table-candidate-sdk-')), store = new ExtractionStore(':memory:');
  const server = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'read_document_blocks', arguments: { table_request: { table_id: 'table-2', reference_line_indices: [1], row_indices: [1, 2] } } },
      { name: 'submit_candidate_records', arguments: { records: [candidate({ source_unit_ids: ['su-000001'], context_line_indices: [1], supporting_table_evidence: [{ table_id: 'table-2', reference_line_indices: [1], cell_ids: ['cell-3', 'cell-5'] }] })], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: { summary: 'Synthetic table receipt only.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ], { summaryAssessments: () => store.current(f.input.run_id).map(v => ({ record_id: v.record.record_id, expected_version: v.version, issue_codes: [], primary_assessment: 'uncertain' })) });
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
      config: server.config, profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), store,
      directory: resolve(directory, 'run'), strategy: 'baseline', inputOrganization: 'paragraphs', sourceGlyphPolicyVersion: glyphPolicy, tableSupportPolicyVersion: tablePolicy });
    assert.equal(result.task_processing_complete, true); assert.equal(result.coverage.delivery_validation_status, 'passed'); assert.equal(result.candidate_count, 1);
    const delivered = JSON.parse(await readFile(resolve(directory, 'run/delivery.json'), 'utf8')), support = delivered.records[0].supporting_table_evidence[0];
    assert.equal(support.description_evidence[0].exact_quote, f.document.blocks[0]!.text);
    assert.deepEqual(support.value_contexts.map((v: any) => v.fragments[0].exact_quote), ['4.2 ± 1.1', '5.5 ± 1.2']);
    assert.ok(support.value_contexts[0].context_fragments.some((f: any) => f.exact_quote === 'Case 1 CT Group A'));
    assert.ok(support.value_contexts[1].context_fragments.some((f: any) => f.exact_quote === 'Case 1 CT Group B')); assert.equal(result.medical_quality_approved, false);
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const failLast of [false, true]) test(`installed SDK loopback counts a long parent only when all parts explicitly complete (${failLast ? 'last fails' : 'success'})`, async () => {
  const f = makeEvidenceFixture(['One complete source statement.', 'Two complete source statement.', 'Three complete source statement.', 'Four complete source statement.', 'Five complete source statement.']); native(f, [0, 1, 2, 3, 4]); issueGlyph(f);
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/paragraph-sdk-')), store = new ExtractionStore(':memory:'); let extraction = 0;
  const server = await createRuntimeResponsesFixture(() => {
    if (store.snapshot(f.input.run_id).state === 'extracting') {
      if (failLast && extraction >= 2) return { status: 400 };
      extraction++; return { calls: [{ name: 'read_document_blocks', arguments: {} }, { name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] };
    }
    return { calls: [{ name: 'get_document_context', arguments: {} }, { name: 'submit_candidate_records', arguments: { summary: 'Synthetic flow receipt only.', reviews: [], links: [], updates: [], summary_complete: true } }] };
  });
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
      config: server.config, profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), store,
      directory: resolve(directory, 'run'), strategy: 'baseline', inputOrganization: 'paragraphs', sourceGlyphPolicyVersion: glyphPolicy,
      tableSupportPolicyVersion: tablePolicy, batchOptions: { maxBlocks: 2, contextBlocks: 0 }, stopOnBatchFailure: true });
    assert.equal(result.coverage.dispatched_paragraphs, 1); assert.equal(result.coverage.dispatched_processing_units, 3);
    assert.equal(result.coverage.explicitly_completed_paragraphs, failLast ? 0 : 1); assert.equal(result.task_processing_complete, !failLast);
    assert.deepEqual(result.coverage.source_glyph_quarantined_block_ids, []); assert.ok(result.coverage.source_glyph_issue_block_ids!.includes(f.document.blocks[0]!.block_id));
    const batches = store.batches(f.input.run_id).map(b => b as any); assert.ok(batches.length >= 3);
    const receipts = result.events.filter(e => e.type === 'batch').map(e => e.detail as any); assert.equal(receipts[0].completed_paragraph_ids.length, 0); assert.equal(receipts[1].completed_paragraph_ids.length, 0);
    if (!failLast) { assert.equal(result.coverage.delivery_validation_status, 'passed'); assert.equal(receipts.at(-1).completed_paragraph_ids.length, 1); }
    assert.equal(result.medical_quality_approved, false); assert.ok(server.requests.every(r => r.body.model === server.config.modelId));
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('an empty or wholly nontext source cannot complete through empty batches/summary', async () => {
  const f = makeEvidenceFixture(['\u0001\ufffd\ufffd']), directory = await mkdtemp(resolve('runtime-data/agent-notes/no-usable-source-'));
  issueGlyph(f); const server = await createRuntimeResponsesFixture([]), store = new ExtractionStore(':memory:');
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata, config: server.config,
      profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(resolve(directory, 'ledger.json'), server.endpoint), store, directory: resolve(directory, 'run'),
      strategy: 'baseline', inputOrganization: 'paragraphs', sourceGlyphPolicyVersion: glyphPolicy });
    assert.equal(result.task_processing_complete, false); assert.ok(result.coverage.task_processing_blockers.includes('reliable_source_input_unavailable')); assert.equal(server.requests.length, 0);
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
