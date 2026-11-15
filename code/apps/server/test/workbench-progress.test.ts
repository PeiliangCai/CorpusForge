import test from 'node:test';
import assert from 'node:assert/strict';
import { workbenchRunProgress } from '../src/workbench-progress.js';
import type { WorkbenchEvent, WorkbenchRun } from '../../../packages/contracts/src/workbench.js';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 14, 8, 0, seconds)).toISOString();
const run = (state = 'extracting'): WorkbenchRun => ({ run_id: 'test-run', document_id: 'test-paper', state, fixture: true,
  candidate_count: 2, created_at: at(0), execution_started_at: at(3), queue_wait_ms: 3000 });
const event = (seq: number, type: string, detail: Record<string, unknown>): WorkbenchEvent => ({ run_id: 'test-run', seq, type, timestamp: at(seq), detail });

test('v2 content progress preserves classified parent counts and does not count figure reads or unfinished parts', () => {
  const all = { paragraph: 1, figure_text: 1, text_item: 1 };
  const events = [event(1, 'coverage_inventory', { progress_unit: 'content_units', total_content_units: 3, input_unit_counts: all, dispatched_blocks: 20, total_batches: 4 }),
    event(2, 'batch', { batch_id: 'a', status: 'completed', explicit_completion_received: true, assigned_block_ids: ['line-a'], completed_content_unit_ids: ['paragraph-1'], explicitly_completed_input_unit_counts: { paragraph: 1, figure_text: 0, text_item: 0 } }),
    event(3, 'table_read', { completed_content_unit_ids: ['fake-figure'], input_unit_counts: { figure_text: 999 } }),
    event(4, 'batch', { batch_id: 'figure-part1', status: 'completed', explicit_completion_received: true, assigned_block_ids: ['figure-line'], completed_content_unit_ids: ['paragraph-1'] })];
  const before = workbenchRunProgress(run(), events)!; assert.equal(before.unit, 'content_units'); assert.equal(before.total, 3); assert.equal(before.completed, 1); assert.deepEqual(before.unit_counts, all);
  assert.deepEqual(before.completed_unit_counts, { paragraph: 1, figure_text: 0, text_item: 0 });
  events.push(event(5, 'batch', { batch_id: 'figure-part2', status: 'completed', explicit_completion_received: true, assigned_block_ids: ['figure-line2'], completed_content_unit_ids: ['paragraph-1', 'figure-1'], explicitly_completed_input_unit_counts: { paragraph: 1, figure_text: 1, text_item: 0 } }));
  assert.equal(workbenchRunProgress(run(), events)!.completed, 2);
  const old = workbenchRunProgress(run('cancelled'), [event(1, 'coverage_inventory', { progress_unit: 'paragraphs', total_paragraphs: 2158, dispatched_blocks: 4484 })])!;
  assert.equal(old.unit, 'paragraphs'); assert.equal(old.total, 2158); assert.equal(old.unit_counts, undefined);
});

test('paragraph progress follows completed parent receipts and ignores supplemental reads and failed parts', () => {
  const events = [event(1, 'coverage_inventory', { progress_unit: 'paragraphs', total_paragraphs: 2, dispatched_blocks: 6, total_batches: 3 }),
    event(2, 'batch', { batch_id: 'part1', status: 'completed', assigned_block_ids: ['a', 'b'], completed_paragraph_ids: [] }),
    event(3, 'table_read', { block_ids: ['c', 'd'], completed_paragraph_ids: ['fake'] }),
    event(4, 'batch', { batch_id: 'part2', status: 'failed', assigned_block_ids: ['c'], completed_paragraph_ids: ['fake'] })];
  const before = workbenchRunProgress(run(), events)!; assert.equal(before.unit, 'paragraphs'); assert.equal(before.completed, 0); assert.equal(before.total, 2);
  events.push(event(5, 'batch', { batch_id: 'part2', status: 'completed', explicit_completion_received: true, assigned_block_ids: ['c'], completed_paragraph_ids: ['parent1'] }));
  const after = workbenchRunProgress(run(), events)!; assert.equal(after.completed, 1); assert.equal(after.total, 2);
  assert.equal(workbenchRunProgress(run('partial'), [], { unit: 'paragraphs', completed: 1, total: 2 })!.unit, 'paragraphs');
});

test('source progress counts successful explicit batches once and keeps glyph gaps visible', () => {
  const events = [event(1, 'state', { state: 'extracting' }),
    event(2, 'coverage_inventory', { dispatched_blocks: 3, total_batches: 2, source_gap_blocks: 1 }),
    event(3, 'batch', { batch_id: 'a', status: 'failed', assigned_block_ids: ['x', 'y'], read_block_ids: ['x', 'y'] }),
    event(4, 'batch', { batch_id: 'a', status: 'completed', explicit_completion_received: true, assigned_block_ids: ['x', 'y'] }),
    event(5, 'batch', { batch_id: 'a', status: 'completed', assigned_block_ids: ['x', 'y'] }),
    event(6, 'batch', { batch_id: 'b', status: 'completed', explicit_completion_received: false, assigned_block_ids: ['z'] }),
    event(7, 'document_summary', { complete: false, source_blocks_read: 99 })];
  const p = workbenchRunProgress(run(), events, {}, Date.parse(at(20)))!;
  assert.equal(p.completed, 2); assert.equal(p.total, 3); assert.equal(p.unit, 'source_blocks');
  assert.equal(p.completed_batches, 1); assert.equal(p.total_batches, 2); assert.equal(p.source_gap_blocks, 1);
  assert.equal(p.summary_completed, false); assert.equal(p.elapsed_ms, 20000); assert.equal(p.execution_elapsed_ms, 17000);
  assert.equal(p.queue_wait_ms, 3000); assert.equal(p.activity, 'source_extraction');
});

test('all dispatched blocks still require reconciliation and do not erase an uncovered source gap', () => {
  const events = [event(1, 'coverage_inventory', { dispatched_blocks: 2, source_glyph_quarantined_block_ids: ['gap', 'gap'] }),
    event(2, 'batch', { batch_id: 'a', status: 'completed', assigned_block_ids: ['x', 'y'] }),
    event(3, 'state', { state: 'reconciling' }), event(4, 'document_summary', { complete: false })];
  const p = workbenchRunProgress(run('reconciling'), events)!;
  assert.equal(p.completed, p.total); assert.equal(p.stage, 'reconciling'); assert.equal(p.summary_completed, false);
  assert.equal(p.source_gap_blocks, 1); assert.equal(p.activity, 'whole_document_reconciliation');
  assert.equal(p.total_batches, undefined);
});

test('unknown parsing totals and distinct terminal outcomes never fabricate a final percentage', () => {
  const parsing = workbenchRunProgress(run('parsing'), [event(1, 'source_parse_started', {})])!;
  assert.equal(parsing.total, undefined); assert.equal(parsing.completed, undefined); assert.equal(parsing.activity, 'pdf_parse');
  const figures = workbenchRunProgress(run('parsing'), [event(1, 'source_parse_started', {}), event(2, 'figure_discovery_started', {})])!;
  assert.equal(figures.activity, 'figure_discovery');
  for (const state of ['partial', 'failed', 'cancelled', 'interrupted', 'completed']) {
    const p = workbenchRunProgress({ ...run(state), finished_at: at(7) }, [event(4, 'state', { state })], {}, Date.parse(at(30)))!;
    assert.equal(p.stage, state); assert.equal(p.completed, undefined); assert.equal(p.total, undefined);
    assert.equal(p.elapsed_ms, 7000); assert.equal(p.activity, undefined);
  }
});

test('legacy coverage remains optional and malformed counter totals do not manufacture progress', () => {
  const historical = { ...run('partial'), created_at: undefined, execution_started_at: undefined };
  const p = workbenchRunProgress(historical, [], { completed: 4, total: 5, summary_completed: false, source_gap_blocks: 1 })!;
  assert.equal(p.telemetry, 'legacy_coverage'); assert.equal(p.completed, 4); assert.equal(p.elapsed_ms, undefined);
  assert.equal(workbenchRunProgress(historical, [])!.telemetry, 'unavailable');
  assert.equal(workbenchRunProgress(historical, [], { completed: 6, total: 5 })!.total, undefined);
});
