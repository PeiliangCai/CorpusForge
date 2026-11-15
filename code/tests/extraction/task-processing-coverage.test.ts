import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtractionStore } from '../../packages/agent/src/extraction-store.js';
import { ExtractionBudget } from '../../packages/agent/src/extraction-budget.js';
import { developmentProfile } from '../../packages/agent/src/extraction-pi.js';
import { runExtractionDocument } from '../../packages/agent/src/extraction-run.js';
import { makeEvidenceFixture } from './fixtures/evidence-fixtures.js';
import { createRuntimeResponsesFixture } from './fixtures/runtime-responses.js';
import { TASK_COMPLETION_RULE_VERSION } from '../../packages/contracts/src/workbench.js';

test('completed selected text and summary remain separate from bibliography, bitmap OCR and legacy full-PDF status', async () => {
  const f = makeEvidenceFixture(['CT shows spiculation.', 'References', '1. Smith A. CT. J Med. 2024;2:1-8.']);
  f.document.pages[0]!.bitmap_count = 1; f.document.pages[0]!.ocr_requirement = 'possible_image_text_unverified';
  f.document.coverage.image_text_unverified_pages = [1]; f.document.parser.status = 'partial';
  const sourceBefore = JSON.stringify(f.document), directory = await mkdtemp(join(tmpdir(), 'task-completion-'));
  const server = await createRuntimeResponsesFixture([
    { calls: [{ name: 'read_document_blocks', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { summary: 'Local transport fixture only.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ]);
  const store = new ExtractionStore(':memory:');
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, metadata: f.context.metadata, catalog: f.catalog,
      config: server.config, profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint),
      store, directory: join(directory, 'run'), strategy: 'baseline' });
    assert.equal(result.error, undefined); assert.equal(result.state, 'partial');
    assert.equal(result.task_processing_complete, true); assert.equal(result.coverage.task_processing_complete, true);
    assert.equal(result.coverage.selected_source_block_processing_complete, true); assert.equal(result.coverage.whole_document_summary_complete, true);
    assert.equal(result.coverage.task_scope_source_blocks, 2); assert.equal(result.coverage.task_scope_source_block_processing_complete, true);
    assert.deepEqual(result.coverage.task_scope_unprocessed_source_block_ids, []); assert.deepEqual(result.coverage.task_processing_blockers, []);
    assert.deepEqual(result.coverage.shared_bibliography_excluded_source_block_ids, [f.document.blocks[2]!.block_id]);
    assert.deepEqual(result.coverage.original_article_unprocessed_source_block_ids, [f.document.blocks[2]!.block_id]);
    assert.deepEqual(result.coverage.f_unselected_source_block_ids, []);
    assert.equal(result.coverage.source_text_layer_decode_complete, true); assert.deepEqual(result.coverage.parser_failed_pages, []);
    assert.deepEqual(result.coverage.image_text_unverified_pages, [1]); assert.equal(result.coverage.parser_status, 'partial');
    assert.equal(result.coverage.full_document_extraction_completed, false); assert.equal(result.coverage.source_fidelity_human_verified, false);
    assert.equal(JSON.stringify(f.document), sourceBefore);
    assert.equal(JSON.stringify(server.requests).includes('Smith'), false);
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const allUnreliable of [false, true]) test(allUnreliable ? 'no reliable input cannot succeed through empty batches and summary' : 'reliable input and automatic summary complete independently of isolated glyph gaps, including zero candidates', async () => {
  const f = makeEvidenceFixture(allUnreliable ? ['Unreliable source.'] : ['A reliable source statement.', 'Unreliable source.']);
  const unsafe = f.document.blocks.at(-1)!;
  unsafe.source_glyph_issues = [{ code: 'sparse_embedded_font_without_unicode_mapping', start: 0, end: 1,
    font_name: 'Synthetic', font_program_sha256: 'a'.repeat(64), pdf_character_code: 1, precision: 'glyph_offset' }];
  f.document.parser.status = 'partial';
  const directory = await mkdtemp(join(tmpdir(), 'task-glyph-flow-'));
  const server = await createRuntimeResponsesFixture(allUnreliable ? [] : [
    { calls: [{ name: 'read_document_blocks', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { records: [], batch_complete: true } }] },
    { calls: [{ name: 'get_document_context', arguments: {} }] },
    { calls: [{ name: 'submit_candidate_records', arguments: { summary: 'Synthetic zero candidate completion.', reviews: [], links: [], updates: [], summary_complete: true } }] },
  ]), store = new ExtractionStore(':memory:');
  try {
    const result = await runExtractionDocument({ input: f.input, document: f.document, catalog: f.catalog, metadata: f.context.metadata,
      config: server.config, profile: developmentProfile(server.config.modelId), budget: new ExtractionBudget(join(directory, 'ledger.json'), server.endpoint),
      store, directory: join(directory, 'run'), strategy: 'baseline' });
    assert.equal(result.coverage.task_completion_rule_version, TASK_COMPLETION_RULE_VERSION);
    assert.equal(result.task_processing_complete, !allUnreliable); assert.equal(result.candidate_count, 0);
    assert.equal(result.coverage.whole_document_summary_complete, !allUnreliable);
    assert.deepEqual(result.coverage.source_glyph_quarantined_block_ids, [unsafe.block_id]);
    assert.deepEqual(result.coverage.task_scope_unprocessed_source_block_ids, [unsafe.block_id]);
    assert.equal(result.coverage.task_scope_source_block_processing_complete, false);
    assert.equal(result.coverage.full_document_extraction_completed, false);
    assert.equal(JSON.stringify(server.requests).includes('Unreliable source'), false, 'isolated source stays outside all model requests');
    if (allUnreliable) { assert.equal(server.requests.length, 0); assert.ok(result.coverage.task_processing_blockers.includes('reliable_source_input_unavailable')); }
    else { assert.equal(result.error, undefined); assert.equal(result.coverage.delivery_validation_status, 'passed'); assert.equal(result.state, 'partial'); }
  } finally { store.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});
