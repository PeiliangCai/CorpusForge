import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore } from '@t1/agent';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { TASK_COMPLETION_RULE_VERSION } from '../../../packages/contracts/src/workbench.js';
import { controlledFixture } from './controlled-fixture.js';

async function setup() {
  const directory = await mkdtemp(resolve('runtime-data/item5-completion-api-')), store = new ExtractionStore(resolve(directory, 'fixture.sqlite'));
  const replay = await controlledFixture({ delayMs: 1 }); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), reconciling = new Promise<void>(resolve => { entered = resolve; });
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, ...replay, runner: {
    controlled: true, provider: 'no-model', model_id: 'no-model', execute: async context => {
      context.store.transition(context.input.run_id, 'extracting'); context.store.transition(context.input.run_id, 'reconciling'); context.store.transition(context.input.run_id, 'partial'); entered(); await gate;
      return { coverage: { task_completion_rule_version: TASK_COMPLETION_RULE_VERSION, task_processing_complete: true,
        whole_document_summary_complete: true, delivery_validation_status: 'passed', source_glyph_quarantined_block_ids: [context.document.blocks[0]!.block_id] } };
    },
  } });
  const paper = (await workflow.upload(await readFile('evaluation/corpus/development-candidates/L05.pdf'), 'synthetic-api.pdf')).paper;
  return { workflow, store, paper, release, reconciling, close: async () => { release(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); } };
}

test('list/detail share saved versioned completion and exact gap locations, while terminal finalization remains incomplete', async () => {
  const x = await setup();
  try {
    const id = (await x.workflow.start(x.paper.id, x.workflow.scopeCatalog().default_scope)).run.run_id; await x.reconciling;
    const early = (await x.workflow.runs(id))[0]!;
    assert.equal(early.state, 'reconciling'); assert.equal(early.result_ready, false); assert.equal(early.task_completion, undefined);
    x.release(); await x.workflow.waitForIdle();
    const listed = (await x.workflow.runs(id))[0]!, detail = await x.workflow.runDetail(id);
    assert.equal(listed.state, 'partial'); assert.equal(listed.task_processing_complete, true); assert.equal(listed.result_ready, true);
    assert.equal(listed.task_completion?.processing_complete, true); assert.equal(listed.task_completion?.source_gap_blocks, 1);
    assert.deepEqual(detail.run.task_completion, listed.task_completion); assert.deepEqual(detail.output.task_completion, listed.task_completion);
    assert.equal(detail.output.source_gaps?.length, 1); assert.ok(detail.output.source_gaps![0]!.physical_page > 0); assert.ok(detail.output.source_gaps![0]!.text_version);
    x.store.db.prepare("DELETE FROM s4_events WHERE run_id=? AND json_extract(payload_json,'$.type')='run_result_saved'").run(id);
    assert.equal((await x.workflow.runs(id))[0]!.task_completion?.processing_complete, false, 'missing final-save evidence cannot certify success');
  } finally { await x.close(); }
});

test('a failure writing the final saved marker cannot advertise a completed new flow', async () => {
  const x = await setup(), save = x.workflow['saveRun'].bind(x.workflow);
  x.workflow['saveRun'] = row => { if (row.finished_at) throw new Error('synthetic_final_save_failure'); save(row); };
  try {
    const id = (await x.workflow.start(x.paper.id, x.workflow.scopeCatalog().default_scope)).run.run_id; await x.reconciling;
    x.release(); await assert.rejects(x.workflow.waitForIdle(), /synthetic_final_save_failure/);
    const listed = (await x.workflow.runs(id))[0]!;
    assert.equal(listed.task_processing_complete, true, 'the earlier coverage write is not itself finalization');
    assert.equal(listed.finished_at, undefined); assert.equal(listed.task_completion?.processing_complete, false);
  } finally { await x.close(); }
});
