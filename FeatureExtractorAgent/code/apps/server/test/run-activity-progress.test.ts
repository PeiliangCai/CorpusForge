import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ExtractionStore } from '@t1/agent';
import type { WorkbenchRun, WorkbenchEvent } from '../../../packages/contracts/src/workbench.js';
import { workbenchRunProgress } from '../src/workbench-progress.js';
import { WorkbenchWorkflow } from '../src/workflow.js';
import { controlledFixture } from './controlled-fixture.js';
const at = (n: number) => new Date(Date.UTC(2026, 10, 15, 11, 0, n)).toISOString();
const run = (state = 'extracting'): WorkbenchRun => ({ run_id: 'own-run', document_id: 'own-paper', state, fixture: true, candidate_count: 0, created_at: at(0) });
const event = (n: number, type: string, detail: Record<string, unknown>): WorkbenchEvent => ({ run_id: 'own-run', seq: n, timestamp: at(n), type, detail });
const activity = (n: number, value: Record<string, unknown>, index = 1) => event(n, 'run_activity', { batch_id: `batch-${String(index).padStart(4, '0')}`, batch_index: index, activity: value });

test('real request start, first provider event and finish distinguish waiting from response without advancing source counts', () => {
  const events = [event(1, 'coverage_inventory', { dispatched_blocks: 20, total_batches: 4 }),
    event(2, 'batch_started', { batch_id: 'batch-0001', batch_index: 1 }),
    activity(3, { type: 'request_started', request_id: 'request-a', started_at: at(3), attempt: 0, max_retries: 2 })];
  const p = () => workbenchRunProgress(run(), events, {}, Date.parse(at(30)))!;
  assert.equal(p().operation!.state, 'waiting_response'); assert.equal(p().operation!.elapsed_ms, 27000); assert.equal(p().completed, 0);
  events.push(activity(4, { type: 'request_response', request_id: 'request-a', started_at: at(3) }));
  assert.equal(p().operation!.state, 'receiving_response'); assert.equal(p().completed_batches, 0);
  events.push(activity(5, { type: 'request_finished', request_id: 'request-a', started_at: at(3), finished_at: at(5), outcome: 'response_received' }));
  assert.equal(p().operation, undefined); assert.equal(p().last_request!.finished_at, at(5)); assert.equal(p().current_batch_index, 1);
});

test('late request and tool endings cannot clear a newer identity or move the current batch backwards', () => {
  const events = [event(1, 'batch_started', { batch_id: 'batch-0002', batch_index: 2 }),
    activity(2, { type: 'request_started', request_id: 'new-request', started_at: at(2) }, 2),
    activity(3, { type: 'request_finished', request_id: 'old-request', started_at: at(0), finished_at: at(3), outcome: 'failed' }, 2),
    activity(4, { type: 'tool_finished', tool_call_id: 'old-tool', tool_name: 'read_document_blocks', started_at: at(0) }, 2),
    activity(5, { type: 'request_started', request_id: 'late-batch-one', started_at: at(0) }, 1)];
  assert.equal(workbenchRunProgress(run(), events)!.operation!.state, 'waiting_response'); assert.equal(workbenchRunProgress(run(), events)!.current_batch_index, 2);
  events.push(activity(6, { type: 'tool_started', tool_call_id: 'new-tool', tool_name: 'read_document_blocks', started_at: at(6) }, 2));
  events.push(activity(7, { type: 'tool_finished', tool_call_id: 'old-tool', tool_name: 'read_document_blocks', started_at: at(0) }, 2));
  assert.equal(workbenchRunProgress(run(), events)!.operation!.kind, 'tool');
  events.push(activity(8, { type: 'tool_finished', tool_call_id: 'new-tool', tool_name: 'read_document_blocks', started_at: at(6) }, 2));
  assert.equal(workbenchRunProgress(run(), events)!.operation, undefined);
  events.push(event(9, 'state', { state: 'reconciling' }), event(10, 'run_activity', { phase: 'whole_document_summary', activity: { type: 'request_started', request_id: 'summary', started_at: at(10) } }),
    activity(11, { type: 'tool_started', tool_call_id: 'late-batch-tool', tool_name: 'read_document_blocks', started_at: at(0) }, 2));
  assert.equal(workbenchRunProgress(run('reconciling'), events)!.operation!.kind, 'model_request');
  assert.equal(workbenchRunProgress(run('reconciling'), events)!.operation!.started_at, at(10));
});

test('retrying batch remains unfinished and final failed/successful counts differ from current batch index', () => {
  const events = [event(1, 'coverage_inventory', { dispatched_blocks: 3, total_batches: 3 }), event(2, 'batch_started', { batch_id: 'batch-0001', batch_index: 1 }),
    event(3, 'batch', { batch_id: 'batch-0001', status: 'failed', assigned_block_ids: ['a'] }),
    activity(4, { type: 'retry_scheduled', started_at: at(4), attempt: 1, max_retries: 2 })];
  assert.equal(workbenchRunProgress(run(), events)!.failed_batches, 0); assert.equal(workbenchRunProgress(run(), events)!.operation!.kind, 'retry');
  events.push(event(5, 'batch_failed', { batch_id: 'batch-0001', batch_index: 1 }), event(6, 'batch_started', { batch_id: 'batch-0002', batch_index: 2 }),
    event(7, 'batch', { batch_id: 'batch-0002', status: 'completed', explicit_completion_received: true, assigned_block_ids: ['b'] }), event(8, 'batch_started', { batch_id: 'batch-0003', batch_index: 3 }));
  const p = workbenchRunProgress(run(), events)!; assert.equal(p.failed_batches, 1); assert.equal(p.completed_batches, 1); assert.equal(p.current_batch_index, 3); assert.equal(p.completed, 1);
  const legacy = workbenchRunProgress(run(), events.filter(e => !['batch_started', 'batch_failed', 'run_activity'].includes(e.type)))!;
  assert.equal(legacy.failed_batches, 1); assert.equal(legacy.current_batch_index, undefined); assert.equal(legacy.operation, undefined);
});

test('every terminal state clears stale work and old missing metadata never invents a request start', () => {
  for (const state of ['completed', 'partial', 'failed', 'cancelled', 'interrupted']) {
    const p = workbenchRunProgress(run(state), [event(1, 'state', { state }), event(2, 'batch_started', { batch_id: 'batch-0001', batch_index: 1 }),
      activity(3, { type: 'request_started', request_id: 'late', started_at: at(3) })])!;
    assert.equal(p.operation, undefined); assert.equal(p.current_batch_index, undefined); assert.equal(p.activity, undefined);
  }
  const old = workbenchRunProgress(run(), [event(1, 'retry', { next_attempt: 1 }), event(2, 'tool', { name: 'read_document_blocks' })])!;
  assert.equal(old.operation, undefined); assert.equal(old.current_batch_index, undefined); assert.equal(old.last_request, undefined);
});

test('light SQL list and exact detail share current activity, invalidation and terminal cleanup', async () => {
  const directory = await mkdtemp(resolve('runtime-data/agent-notes/run-activity-api-')), store = new ExtractionStore(resolve(directory, 'fixture.sqlite'));
  const fixture = await controlledFixture({ delayMs: 1 }); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const workflow = new WorkbenchWorkflow(store, { directory, sources: false, ...fixture, runner: { controlled: true, provider: 'fixture', model_id: 'fixture', execute: async c => {
    c.store.transition(c.input.run_id, 'extracting'); c.store.event(c.input.run_id, 'coverage_inventory', { dispatched_blocks: 2, total_batches: 3 });
    c.store.batch(c.input.run_id, 'batch-0001', { status: 'failed', assigned_block_ids: ['a'] }); c.store.event(c.input.run_id, 'batch_failed', { batch_id: 'batch-0001', batch_index: 1 });
    c.store.event(c.input.run_id, 'batch_started', { batch_id: 'batch-0002', batch_index: 2 });
    c.store.event(c.input.run_id, 'run_activity', { batch_id: 'batch-0002', batch_index: 2, activity: { type: 'request_started', request_id: 'active', started_at: new Date().toISOString(), attempt: 0, max_retries: 2 } });
    entered(); await gate; c.store.transition(c.input.run_id, 'partial'); return { coverage: { task_processing_complete: false, whole_document_summary_complete: false } };
  } } });
  try {
    const paper = (await workflow.upload(await readFile('evaluation/corpus/development-candidates/L05.pdf'), 'activity-api-fixture.pdf')).paper;
    const id = (await workflow.start(paper.id, workflow.scopeCatalog().default_scope)).run.run_id; await ready;
    const fields = (p: NonNullable<WorkbenchRun['progress']>) => ({ current: p.current_batch_index, failures: p.failed_batches, started: p.operation?.started_at, state: p.operation?.state });
    const first = (await workflow.runs(id))[0]!.progress!; assert.equal(first.failed_batches, 1); assert.equal(first.current_batch_index, 2); assert.equal(first.operation!.state, 'waiting_response');
    assert.deepEqual(fields((await workflow.runDetail(id)).run.progress!), fields(first));
    store.event(id, 'run_activity', { batch_id: 'batch-0002', batch_index: 2, activity: { type: 'request_finished', request_id: 'active', started_at: first.operation!.started_at, finished_at: new Date().toISOString(), outcome: 'failed', error_code: 'request_time_limit' } });
    assert.equal((await workflow.runs(id))[0]!.progress!.operation, undefined); assert.equal((await workflow.runDetail(id)).run.progress!.last_request!.error_code, 'request_time_limit');
    release(); await workflow.waitForIdle(); assert.equal((await workflow.runs(id))[0]!.progress!.current_batch_index, undefined);
  } finally { release?.(); await workflow.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
