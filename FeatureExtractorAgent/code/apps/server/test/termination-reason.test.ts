import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore } from '@t1/agent';
import type { WorkbenchRun } from '../../../packages/contracts/src/workbench.js';
import { workbenchRunProgress } from '../src/workbench-progress.js';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { controlledFixture } from './controlled-fixture.js';
const codes = ['experiment_input_token_limit', 'experiment_output_token_limit', 'experiment_request_limit', 'experiment_time_limit', 'document_time_limit', 'request_time_limit', 'pi_session_time_limit'];
const run: WorkbenchRun = { run_id: 'same-run', document_id: 'same-paper', fixture: true, candidate_count: 20, state: 'partial', result_ready: true, finished_at: '2026-11-15T11:22:31Z', task_processing_complete: false };

test('only unambiguous final bound host reasons classify a stopped incomplete run; unknown and ongoing work never infer a budget cause', () => {
  for (const code of codes) assert.equal(workbenchRunProgress(run, [], { task_processing_blockers: ['summary_incomplete', code] })!.termination_reason, code);
  const coverage = { task_processing_blockers: ['experiment_input_token_limit'] };
  for (const changed of [{ state: 'extracting' }, { result_ready: false }, { finished_at: undefined }, { state: 'completed' }, { state: 'cancelled' }, { state: 'interrupted' }, { task_processing_complete: true }]) {
    assert.equal(workbenchRunProgress({ ...run, ...changed }, [], coverage)!.termination_reason, undefined);
  }
  assert.equal(workbenchRunProgress(run, [])!.termination_reason, undefined);
  assert.equal(workbenchRunProgress(run, [], { task_processing_blockers: ['selected_input_processing_incomplete', 'supplier was slow'] })!.termination_reason, undefined);
  assert.equal(workbenchRunProgress(run, [], { task_processing_blockers: ['experiment_input_token_limit', 'request_time_limit'] })!.termination_reason, undefined);
  assert.equal(workbenchRunProgress({ ...run, error: 'experiment_input_token_limit' }, [])!.termination_reason, 'experiment_input_token_limit');
  assert.equal(workbenchRunProgress(run, [{ run_id: run.run_id, seq: 1, timestamp: run.finished_at!, type: 'run_activity', detail: { activity: { type: 'request_finished', request_id: 'old', started_at: run.finished_at, finished_at: run.finished_at, outcome: 'failed', error_code: 'request_time_limit' } } }])!.termination_reason, undefined, 'an earlier request timeout is not proof of the final stopping cause');
});

test('persisted final coverage projects a reason with error absent in both list and detail and never borrows another run cause', async () => {
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/termination-api-')), store = new ExtractionStore(resolve(directory, 'fixture.sqlite')), fixture = await controlledFixture({ delayMs: 1 }); let execution = 0;
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, ...fixture, runner: { controlled: true, provider: 'fixture', model_id: 'fixture', execute: async c => {
    c.store.transition(c.input.run_id, 'extracting'); c.store.transition(c.input.run_id, 'partial');
    return { coverage: { task_processing_complete: false, whole_document_summary_complete: false,
      task_processing_blockers: execution++ === 0 ? ['selected_input_processing_incomplete', 'summary_incomplete', 'experiment_input_token_limit'] : ['summary_incomplete'] } };
  } } });
  try {
    const paper = (await workflow.upload(await readFile('evaluation/corpus/development-candidates/L05.pdf'), 'termination-fixture.pdf')).paper;
    const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await workflow.waitForIdle();
    const first = (await workflow.runs(id))[0]!; assert.equal(first.error, undefined); assert.equal(first.progress!.termination_reason, 'experiment_input_token_limit');
    assert.equal((await workflow.runDetail(id)).run.progress!.termination_reason, first.progress!.termination_reason);
    const otherId = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await workflow.waitForIdle();
    assert.equal((await workflow.runs(otherId))[0]!.progress!.termination_reason, undefined); assert.equal((await workflow.runDetail(otherId)).run.progress!.termination_reason, undefined);
  } finally { await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
