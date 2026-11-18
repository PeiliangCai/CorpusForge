import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore, buildEvidenceDelivery, buildSourceEvidenceUnits, validateEvidenceSubmission } from '@t1/agent';
import { expandBatchLineEvidence } from '../../../packages/agent/src/extraction-protocol.js';
import { TASK_COMPLETION_RULE_VERSION } from '../../../packages/contracts/src/workbench.js';
import { makeEvidenceFixture } from '../../../tests/extraction/fixtures/evidence-fixtures.js';
import { WorkbenchWorkflow } from '../src/workflow.js';

test('isolated workflow projects same-record table values and paragraph unit, and retained downloads keep exact supplements', async () => {
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/paragraph-table-api-')), store = new ExtractionStore(resolve(directory, 'fixture.sqlite'));
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, parse: async (input, path) => {
    const { document: d } = makeEvidenceFixture(['CT shows a round nodule.', 'Its diameter is given in Table 2.', 'Table 2 Diameter', 'Diameter (mm)', '4.2 ± 1.1']);
    d.document_id = input.document_id; d.file_sha256 = input.file_sha256; d.fixture = false; d.evidence_kind = 'real_paper'; d.source.file_reference = path;
    d.parser.config.font_glyph_guard_version = 'sparse-embedded-font-no-unicode-1';
    for (const b of d.blocks) b.document_id = input.document_id;
    const unit = (id: string, indices: number[], kind: 'text' | 'caption' | 'table_cell') => {
      d.structure.units.push({ unit_id: id, native_ref: '#/' + id, kind, native_label: kind, native_text: 'not quoted', native_original_text: null,
        native_text_role: 'processed_native_not_literal_quote', content_layer: 'body', provenance: [], source_segments: indices.map(i => ({ block_id: d.blocks[i]!.block_id,
          text_version: d.text_version, start: 0, end: Array.from(d.blocks[i]!.text).length })), mapping: { status: 'exact', method: 'geometry_and_nfkd_whitespace_hyphen_alignment_4',
          matched_native_code_points: 1, alignable_native_code_points: 1, transformations: [], warnings: [] } }); d.structure.reading_order.push(id);
    };
    unit('paragraph', [0, 1], 'text'); unit('caption', [2], 'caption'); unit('header', [3], 'table_cell'); unit('value', [4], 'table_cell');
    d.structure.tables.push({ table_id: 'table-2', native_ref: '#/table', physical_pages: [1], caption_unit_ids: ['caption'], footnote_unit_ids: [], association_basis: 'native_explicit',
      n_rows: 2, n_cols: 1, cells: ['header', 'value'].map((unit_id, i) => ({ unit_id, row_start: i, row_end: i + 1, col_start: 0, col_end: 1,
        row_span: 1, col_span: 1, column_header: i === 0, row_header: false, row_section: false })), native_html: null, cross_page_continuation: 'not_assumed' });
    d.blocks[0]!.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 0, end: 1, font_name: 'Synthetic',
      font_program_sha256: 'a'.repeat(64), pdf_character_code: 1, precision: 'glyph_offset' }]; d.parser.status = 'partial'; return d;
  }, discover: async () => { throw new Error('synthetic_no_figures'); }, runner: { controlled: true, provider: 'no-provider', model_id: 'no-model', execute: async c => {
    c.store.transition(c.input.run_id, 'extracting');
    const glyph = 'agent-assesses-parsed-glyphs-1' as const, table = 'paragraph-linked-table-support-2' as const;
    const units = buildSourceEvidenceUnits(c.document, glyph), binding = { task_id: c.metadata.task_id, run_id: c.input.run_id, document_id: c.input.document_id,
      file_sha256: c.input.file_sha256, source_version: c.metadata.source_version.version, text_version: c.document.text_version };
    const submission = expandBatchLineEvidence({ source_unit_ids: [units[0]!.unit_id], context_line_indices: [1], supporting_table_evidence: [{ table_id: 'table-2',
      reference_line_indices: [1], cell_ids: ['value'] }], feature_name_raw: null, feature_category: 'synthetic', evidence_type: 'imaging_observation', assertion: 'affirmed', origin: 'study_authors' }, c.document.blocks, binding, units, c.document);
    const result = validateEvidenceSubmission(submission, { input: c.input, document: c.document, catalog: c.evidence_catalog!, metadata: c.metadata,
      allowedBlockIds: c.document.blocks.map(b => b.block_id), readBlockIds: c.document.blocks.map(b => b.block_id), toolCallId: 'fixture', evidencePolicyVersion: 'visual-statements-2',
      sourceGlyphPolicyVersion: glyph, tableSupportPolicyVersion: table });
    assert.equal(result.accepted, true, JSON.stringify(result.issues)); const record = result.record!;
    c.store.apply(c.input.run_id, { action: 'insert', record, expected_version: null, target_record_id: null, related_record_ids: [], issues: [], changes: [{ kind: 'insert', record_id: record.record_id, expected_version: null, record }] });
    buildEvidenceDelivery(c.document, c.store.versions(c.input.run_id));
    c.store.transition(c.input.run_id, 'reconciling'); c.store.transition(c.input.run_id, 'partial');
    return { coverage: { task_completion_rule_version: TASK_COMPLETION_RULE_VERSION, task_processing_complete: true, delivery_validation_status: 'passed', whole_document_summary_complete: true,
      progress_unit: 'paragraphs', input_organization_version: 'source-paragraph-units-1', dispatched_paragraphs: 4, explicitly_completed_paragraphs: 4,
      source_glyph_policy_version: glyph, source_glyph_issue_block_ids: [c.document.blocks[0]!.block_id], source_glyph_quarantined_block_ids: [], table_support_policy_version: table } };
  } } });
  try {
    const paper = (await workflow.upload(await readFile('evaluation/corpus/development-candidates/L05.pdf'), 'offline-table-api.pdf')).paper;
    const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await workflow.waitForIdle();
    const listed = (await workflow.runs(id))[0]!, detail = await workflow.runDetail(id);
    assert.equal(listed.error, undefined, JSON.stringify({listed,coverage:detail.output.coverage}));
    assert.equal(listed.progress?.unit, 'paragraphs'); assert.equal(listed.progress?.total, 4); assert.equal(listed.task_completion?.processing_complete, true);
    assert.equal(detail.output.records.length, 1); const record = detail.output.records[0]!;
    assert.equal(record.fragments[0]!.exact_quote, 'CT shows a round nodule.'); assert.equal(record.supporting_table_evidence![0]!.fragments[0]!.exact_quote, '4.2 ± 1.1');
    assert.equal(record.supporting_table_evidence![0]!.description_evidence![0]!.exact_quote, 'CT shows a round nodule.');
    assert.equal(record.supporting_table_evidence![0]!.value_contexts![0]!.fragments[0]!.exact_quote, '4.2 ± 1.1');
    assert.ok(record.supporting_table_evidence![0]!.value_contexts![0]!.context_fragments.some(f => f.exact_quote === 'Diameter (mm)'));
    assert.equal(record.retention!.status, 'kept'); assert.equal(detail.output.source_gaps?.length, 0);
    const csv = await workflow.export(id, 'retained_csv'); assert.ok(csv.bytes.toString().includes('supporting_table_evidence_json') && csv.bytes.toString().includes('4.2 ± 1.1'));
    const json = await workflow.export(id, 'retained_jsonl'); const saved = JSON.parse(json.bytes.toString());
    assert.equal(saved.supporting_table_evidence[0].context_fragments.some((f: any) => f.exact_quote === 'Diameter (mm)'), true);
    assert.equal(saved.supporting_table_evidence[0].value_contexts[0].context_fragments.some((f: any) => f.exact_quote === 'Diameter (mm)'), true);
    assert.equal(saved.medical_quality_approved, false); assert.equal(saved.human_confirmation, null);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
