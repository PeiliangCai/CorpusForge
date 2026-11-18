import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore } from '@t1/agent';
import { controlledFixture } from './controlled-fixture.js';
import { WorkbenchWorkflow } from '../src/workflow.js';

test('light SQL list/detail projection preserves v2 content classes and leaves old v1 counts without invented categories', async () => {
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/content-progress-api-')), store = new ExtractionStore(resolve(directory, 'fixture.sqlite'));
  const replay = await controlledFixture({ delayMs: 1 }); let release!: () => void, entered!: () => void, execution = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), running = new Promise<void>(resolve => { entered = resolve; });
  const all = { paragraph: 1, figure_text: 1, text_item: 1 }, done = { paragraph: 1, figure_text: 0, text_item: 0 };
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, ...replay, runner: { controlled: true, provider: 'no-provider', model_id: 'no-model', execute: async c => {
    const v2 = execution++ === 0; c.store.transition(c.input.run_id, 'extracting');
    c.store.event(c.input.run_id, 'coverage_inventory', v2 ? { progress_unit: 'content_units', total_content_units: 3, input_unit_counts: all, dispatched_blocks: 20 } : { progress_unit: 'paragraphs', total_paragraphs: 2158, dispatched_blocks: 4484 });
    if (v2) { c.store.batch(c.input.run_id, 'batch-a', { batch_id: 'batch-a', status: 'completed', explicit_completion_received: true, assigned_block_ids: [c.document.blocks[0]!.block_id], completed_content_unit_ids: ['body-1'], explicitly_completed_input_unit_counts: done }); entered(); await gate; }
    c.store.transition(c.input.run_id, 'reconciling'); c.store.transition(c.input.run_id, 'partial');
    return { coverage: { progress_unit: v2 ? 'content_units' : 'paragraphs', task_processing_complete: false, whole_document_summary_complete: false,
      ...(v2 ? { input_organization_version: 'source-content-units-2', dispatched_content_units: 3, explicitly_completed_content_units: 1, input_unit_counts: all, explicitly_completed_input_unit_counts: done }
        : { input_organization_version: 'source-paragraph-units-1', dispatched_paragraphs: 2158, explicitly_completed_paragraphs: 0 }) } };
  } } });
  try {
    const paper = (await workflow.upload(await readFile('evaluation/corpus/development-candidates/L05.pdf'), 'content-api-replay.pdf')).paper;
    const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await running;
    const active = (await workflow.runs(id))[0]!, detail = await workflow.runDetail(id);
    assert.equal(active.progress!.unit, 'content_units'); assert.equal(active.progress!.completed, 1); assert.equal(active.progress!.total, 3);
    assert.deepEqual(active.progress!.unit_counts, all); assert.deepEqual(active.progress!.completed_unit_counts, done);
    const observedWork = (p: typeof active.progress) => ({ unit: p!.unit, completed: p!.completed, total: p!.total, unit_counts: p!.unit_counts, completed_unit_counts: p!.completed_unit_counts });
    assert.deepEqual(observedWork(detail.run.progress), observedWork(active.progress));
    release(); await workflow.waitForIdle(); const saved = (await workflow.runs(id))[0]!;
    assert.equal(saved.progress!.unit, 'content_units'); assert.deepEqual(saved.progress!.unit_counts, all); assert.equal(saved.task_processing_complete, false);
    const oldId = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await workflow.waitForIdle();
    const old = (await workflow.runs(oldId))[0]!; assert.equal(old.progress!.unit, 'paragraphs'); assert.equal(old.progress!.total, 2158); assert.equal(old.progress!.unit_counts, undefined);
    assert.equal((await workflow.runDetail(oldId)).output.coverage && ((await workflow.runDetail(oldId)).output.coverage as any).input_unit_counts, undefined);
  } finally { release?.(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
