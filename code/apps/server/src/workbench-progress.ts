import type { WorkbenchEvent, WorkbenchRun, WorkbenchRunProgress } from '../../../packages/contracts/src/workbench.js';

const stages = new Set<WorkbenchRunProgress['stage']>(['queued', 'parsing', 'extracting', 'reconciling', 'completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const time = (value?: string) => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : undefined;
const ids = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
export interface ProgressCoverage {
  completed?: number; total?: number; summary_completed?: boolean; source_gap_blocks?: number;
  unit?: 'source_blocks' | 'paragraphs' | 'content_units';
  unit_counts?: Record<string, number>; completed_unit_counts?: Record<string, number>;
  task_processing_blockers?: unknown;
}
const terminationCodes = new Set(['experiment_input_token_limit', 'experiment_output_token_limit', 'experiment_request_limit',
  'experiment_time_limit', 'document_time_limit', 'request_time_limit', 'pi_session_time_limit']);
const counts = (value: unknown): Record<string, number> | undefined => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.entries(value).every(([key, n]) => key.length > 0 && count(n) !== undefined) ? value as Record<string, number> : undefined;

/** Pure projection of persisted receipts. A read, retry or summary reread never completes source blocks. */
export function workbenchRunProgress(run: WorkbenchRun, events: readonly WorkbenchEvent[], coverage: ProgressCoverage = {}, clock = Date.now()): WorkbenchRunProgress | undefined {
  if (!stages.has(run.state as WorkbenchRunProgress['stage'])) return undefined;
  let total = coverage.total, totalBatches: number | undefined, gap = coverage.source_gap_blocks, unit = coverage.unit ?? 'source_blocks';
  const completedParagraphs = new Set<string>();
  const completedContent = new Set<string>(); let unitCounts = coverage.unit_counts, completedCounts = coverage.completed_unit_counts;
  let summaryComplete = coverage.summary_completed, inventory = false, activity: WorkbenchRunProgress['activity'];
  let stageStarted: string | undefined, updated: string | undefined, terminalAt: string | undefined;
  let currentBatchId: string | undefined, currentBatchIndex: number | undefined, highestBatchEvidence = 0;
  let operation: WorkbenchRunProgress['operation'], lastRequest: WorkbenchRunProgress['last_request'];
  let activeRequestId: string | undefined, activeToolId: string | undefined;
  let eventPhase: string | undefined;
  const finalFailed = new Set<string>();
  const batchIndex = (id: string) => /^batch-\d+$/u.test(id) ? count(Number(id.slice(6))) : undefined;
  const batches = new Map<string, { complete: boolean; ids: string[] }>();
  for (const event of events) {
    updated = event.timestamp;
    const d = event.detail;
    if (event.type === 'state') {
      eventPhase = typeof d.state === 'string' ? d.state : eventPhase;
      if (d.state === run.state) stageStarted = event.timestamp;
      if (terminal.has(String(d.state))) terminalAt = event.timestamp;
      if (d.state === 'reconciling' || terminal.has(String(d.state))) { operation = undefined; currentBatchId = undefined; currentBatchIndex = undefined; }
    } else if (event.type === 'coverage_inventory') {
      inventory = true; unit = d.progress_unit === 'content_units' ? 'content_units' : d.progress_unit === 'paragraphs' ? 'paragraphs' : unit;
      total = count(unit === 'content_units' ? d.total_content_units : unit === 'paragraphs' ? d.total_paragraphs : d.dispatched_blocks) ?? total; totalBatches = count(d.total_batches);
      if (unit === 'content_units') unitCounts = counts(d.input_unit_counts) ?? unitCounts;
      gap = count(d.source_gap_blocks) ?? (Array.isArray(d.source_glyph_quarantined_block_ids) ? new Set(ids(d.source_glyph_quarantined_block_ids)).size : gap);
    } else if (event.type === 'batch' && typeof d.batch_id === 'string') {
      highestBatchEvidence = Math.max(highestBatchEvidence, batchIndex(d.batch_id) ?? 0);
      batches.set(d.batch_id, { complete: d.status === 'completed' && d.explicit_completion_received !== false, ids: ids(d.assigned_block_ids) });
      if (d.status === 'completed' && d.explicit_completion_received === true) ids(d.completed_paragraph_ids).forEach(id => completedParagraphs.add(id));
      if (d.status === 'completed' && d.explicit_completion_received === true) { ids(d.completed_content_unit_ids).forEach(id => completedContent.add(id)); completedCounts = counts(d.explicitly_completed_input_unit_counts) ?? completedCounts; }
    } else if (event.type === 'batch_started' && typeof d.batch_id === 'string' && count(d.batch_index)) {
      currentBatchId = d.batch_id; currentBatchIndex = count(d.batch_index); highestBatchEvidence = Math.max(highestBatchEvidence, currentBatchIndex!); operation = undefined;
    } else if (event.type === 'batch_failed' && typeof d.batch_id === 'string') {
      finalFailed.add(d.batch_id); if (currentBatchId === d.batch_id) operation = undefined;
    } else if (event.type === 'run_activity' && d.activity && typeof d.activity === 'object') {
      const a = d.activity as Record<string, unknown>;
      // A delayed callback from an older batch/request/tool must not replace current work.
      if (eventPhase === 'reconciling' && typeof d.batch_id === 'string') continue;
      if (count(d.batch_index) && currentBatchIndex && Number(d.batch_index) < currentBatchIndex) continue;
      if (typeof a.started_at !== 'string' || time(a.started_at) === undefined) continue;
      const common = { started_at: a.started_at, elapsed_ms: Math.max(0, clock - Date.parse(a.started_at)),
        ...(count(a.attempt) !== undefined ? { attempt: count(a.attempt) } : {}), ...(count(a.max_retries) !== undefined ? { max_retries: count(a.max_retries) } : {}) };
      if (a.type === 'request_started' && typeof a.request_id === 'string') {
        activeRequestId = a.request_id; operation = { kind: 'model_request', state: 'waiting_response', ...common };
      } else if (a.type === 'request_response' && a.request_id === activeRequestId && operation?.kind === 'model_request') {
        operation = { ...operation, state: 'receiving_response' };
      } else if (a.type === 'request_finished' && a.request_id === activeRequestId) {
        if (typeof a.finished_at === 'string' && time(a.finished_at) !== undefined && (a.outcome === 'failed' || a.outcome === 'response_received')) lastRequest = {
          outcome: a.outcome, finished_at: a.finished_at, ...(typeof a.error_code === 'string' ? { error_code: a.error_code } : {}) };
        if (operation?.kind === 'model_request') operation = undefined;
      } else if (a.type === 'tool_started' && typeof a.tool_call_id === 'string' && typeof a.tool_name === 'string') {
        activeToolId = a.tool_call_id; operation = { kind: 'tool', state: 'executing', tool_name: a.tool_name, ...common };
      } else if (a.type === 'tool_finished' && a.tool_call_id === activeToolId && operation?.kind === 'tool') operation = undefined;
      else if (a.type === 'retry_scheduled') operation = { kind: 'retry', state: 'scheduled', ...common };
    } else if (event.type === 'document_summary' && typeof d.complete === 'boolean') summaryComplete = d.complete;
    else if (event.type === 'source_parse_started') activity = 'pdf_parse';
    else if (event.type === 'figure_discovery_started') activity = 'figure_discovery';
  }
  const done = new Set<string>(); let completedBatches = 0;
  for (const batch of batches.values()) if (batch.complete) { completedBatches++; batch.ids.forEach(id => done.add(id)); }
  for (const [id, batch] of batches) {
    if (batch.complete) finalFailed.delete(id);
    else if (terminal.has(run.state) || (batchIndex(id) ?? Infinity) < highestBatchEvidence) finalFailed.add(id);
  }
  if (terminal.has(run.state) || !['extracting', 'reconciling'].includes(run.state)) { operation = undefined; currentBatchId = undefined; currentBatchIndex = undefined; }
  const completed = batches.size ? unit === 'content_units' ? completedContent.size : unit === 'paragraphs' ? completedParagraphs.size : done.size : coverage.completed ?? (inventory ? 0 : undefined);
  // Inconsistent legacy counters do not justify a fabricated percentage.
  if (total !== undefined && completed !== undefined && completed > total) total = undefined;
  if (run.state === 'queued') activity = undefined;
  else if (run.state === 'parsing') activity ??= 'pdf_parse';
  else if (run.state === 'extracting') activity = 'source_extraction';
  else if (run.state === 'reconciling') activity = 'whole_document_reconciliation';
  else activity = undefined;
  const end = time(run.finished_at) ?? (terminal.has(run.state) ? time(terminalAt) : clock);
  const started = time(run.created_at), executionStarted = time(run.execution_started_at);
  const finalCodes = new Set(Array.isArray(coverage.task_processing_blockers) ? coverage.task_processing_blockers.filter(code => typeof code === 'string' && terminationCodes.has(code)) : []);
  const finalCode = run.error && terminationCodes.has(run.error) ? run.error : finalCodes.size === 1 ? [...finalCodes][0] : undefined;
  const terminationReason = ['partial', 'failed'].includes(run.state) && run.result_ready === true && Boolean(run.finished_at) &&
    run.task_processing_complete !== true && run.task_completion?.processing_complete !== true ? finalCode as WorkbenchRunProgress['termination_reason'] : undefined;
  return {
    schema_version: 't1-workbench-progress-1', stage: run.state as WorkbenchRunProgress['stage'],
    ...(updated ? { updated_at: updated } : {}), ...(stageStarted ? { stage_started_at: stageStarted } : {}),
    ...(end !== undefined && started !== undefined ? { elapsed_ms: Math.max(0, end - started) } : {}),
    ...(end !== undefined && executionStarted !== undefined ? { execution_elapsed_ms: Math.max(0, end - executionStarted) } : {}),
    ...(count(run.queue_wait_ms) !== undefined ? { queue_wait_ms: run.queue_wait_ms } : {}),
    ...(completed !== undefined ? { completed, unit } : {}), ...(total !== undefined ? { total, unit } : {}),
    ...(unit === 'content_units' && unitCounts ? { unit_counts: unitCounts } : {}), ...(unit === 'content_units' && completedCounts ? { completed_unit_counts: completedCounts } : {}),
    ...(inventory || batches.size ? { completed_batches: completedBatches } : {}), ...(totalBatches !== undefined ? { total_batches: totalBatches } : {}),
    ...(inventory || batches.size || finalFailed.size ? { failed_batches: finalFailed.size } : {}),
    ...(currentBatchId ? { current_batch_id: currentBatchId, current_batch_index: currentBatchIndex } : {}), ...(operation ? { operation } : {}), ...(lastRequest ? { last_request: lastRequest } : {}),
    ...(terminationReason ? { termination_reason: terminationReason } : {}),
    candidate_records: run.candidate_count, ...(gap !== undefined ? { source_gap_blocks: gap } : {}),
    ...(summaryComplete !== undefined || inventory ? { summary_completed: summaryComplete ?? false } : {}),
    ...(activity ? { activity } : {}), telemetry: events.length ? 'events' : coverage.completed !== undefined ? 'legacy_coverage' : 'unavailable',
  };
}
