import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TASK_COMPLETION_RULE_VERSION, type WorkbenchRun, type WorkbenchTaskCompletion } from '../../../packages/contracts/src/workbench.js';

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sameIds = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && new Set(a).size === a.length &&
  a.every(id => typeof id === 'string' && b.includes(id));
export interface LegacyCompletionMetadata {
  directory: string; pdf: { path: string; sha256: string }; ir: { path: string; sha256: string };
  document_id: string; file_sha256: string; text_version: string; blockers: unknown; event_seq: number;
  result_saved: boolean; unsafe_events: number;
}

/** Only the audited legacy sole-glyph contract is eligible. Large immutable
 * evidence is read once per file identity; polling otherwise reads file stats.
 * Every result is a response projection, never a database or artifact write. */
export class LegacyCompletionProjection {
  private readonly cache = new Map<string, { key: string; value?: WorkbenchTaskCompletion }>();
  private readonly flights = new Map<string, { key: string; promise: Promise<WorkbenchTaskCompletion | undefined> }>();
  private auditQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly codeRoot: string) {}
  async project(run: WorkbenchRun, metadata: LegacyCompletionMetadata, savedCoverage: () => unknown) {
    if (!['partial', 'completed'].includes(run.state) || run.result_ready !== true || !run.finished_at || run.error ||
      run.task_processing_complete !== false || !sameIds(metadata.blockers, ['source_glyph_quarantine_unresolved']) ||
      !metadata.result_saved || metadata.unsafe_events || metadata.document_id !== run.document_id || metadata.pdf?.sha256 !== metadata.file_sha256 ||
      !metadata.directory || !metadata.ir?.sha256 || !metadata.text_version) return undefined;
    const flightKey = JSON.stringify([metadata, run.finished_at]), flight = this.flights.get(run.run_id);
    if (flight?.key === flightKey) return flight.promise;
    // Serialize cold evidence reads so a long history cannot load many large
    // results and IRs concurrently. Hot checks only inspect file identities.
    const promise = this.auditQueue.then(() => this.audit(run, metadata, savedCoverage)).catch(() => undefined);
    this.auditQueue = promise;
    this.flights.set(run.run_id, { key: flightKey, promise });
    try { return await promise; } finally { if (this.flights.get(run.run_id)?.promise === promise) this.flights.delete(run.run_id); }
  }
  private async audit(run: WorkbenchRun, metadata: LegacyCompletionMetadata, savedCoverage: () => unknown) {
    const root = await realpath(this.codeRoot);
    const paths = await Promise.all(['result.json', 'delivery.json', 'request-ledger.json'].map(name => resolve(metadata.directory, name))
      .concat([resolve(root, metadata.pdf.path), resolve(root, metadata.ir.path)]).map(async value => {
        const path = await realpath(value), rel = relative(root, path);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('completion_evidence_outside_code');
        return path;
      }));
    const identities = async () => Promise.all(paths.map(async path => {
      const s = await stat(path, { bigint: true });
      if (!s.isFile()) throw new Error('completion_evidence_not_file');
      return [path, s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String);
    }));
    const before = await identities(), key = JSON.stringify([metadata, run.finished_at, before]);
    const cached = this.cache.get(run.run_id); if (cached?.key === key) return cached.value;
    let value: WorkbenchTaskCompletion | undefined;
    const [resultBytes, deliveryBytes, ledgerBytes, pdfBytes, irBytes] = await Promise.all(paths.map(path => readFile(path)));
    const result = object(JSON.parse(resultBytes!.toString())), delivery = object(JSON.parse(deliveryBytes!.toString())), ledger = object(JSON.parse(ledgerBytes!.toString()));
    const ir = object(JSON.parse(irBytes!.toString())), coverage = object(result.coverage), persisted = object(savedCoverage());
    const gaps = array(coverage.source_glyph_quarantined_block_ids), events = array(result.events), batches = new Map<string, Record<string, any>>();
    for (const event of events) if (event.type === 'batch' && typeof event.detail?.batch_id === 'string') batches.set(event.detail.batch_id, event.detail);
    const inventory = events.filter(e => e.type === 'coverage_inventory').at(-1)?.detail;
    const summary = events.filter(e => e.type === 'document_summary').at(-1)?.detail;
    const completedIds = [...batches.values()].flatMap(batch => array(batch.assigned_block_ids));
    const delivered = [...array(delivery.records), ...array(delivery.background_records)];
    const resultRecords = array(result.records);
    const sourceValid = sha(pdfBytes!) === metadata.pdf.sha256 && sha(irBytes!) === metadata.ir.sha256 &&
      ir.document_id === run.document_id && ir.file_sha256 === metadata.file_sha256 && ir.text_version === metadata.text_version;
    if (sourceValid && result.schema_version === 's4-extraction-run-1' && result.source_selection_condition === 'B0' &&
      result.run_id === run.run_id && result.document_id === run.document_id && result.state === run.state && !result.error &&
      result.task_processing_complete === false && result.delivery_validation?.status === 'passed' && !result.delivery_validation.error &&
      result.delivery_validation.rejected_delivery_written === false && isDeepStrictEqual(coverage, persisted) &&
      coverage.legacy_run_state_is_not_task_scope_completion === true && !coverage.task_completion_rule_version &&
      sameIds(coverage.task_processing_blockers, ['source_glyph_quarantine_unresolved']) &&
      ['parsed', 'partial'].includes(coverage.parser_status) && coverage.selected_source_block_processing_complete === true &&
      coverage.whole_document_summary_complete === true && coverage.dispatched_source_blocks > 0 && gaps.length > 0 &&
      coverage.explicitly_completed_source_blocks === coverage.dispatched_source_blocks &&
      sameIds(coverage.completed_source_block_ids, [...new Set(completedIds)]) && new Set(completedIds).size === coverage.dispatched_source_blocks &&
      sameIds(coverage.task_scope_unprocessed_source_block_ids, gaps) &&
      ['failed_source_block_ids', 'task_scope_failed_source_block_ids', 'quarantined_source_block_ids'].every(k => Array.isArray(coverage[k]) && coverage[k].length === 0) &&
      batches.size > 0 && inventory?.total_batches === batches.size && inventory.dispatched_blocks === coverage.dispatched_source_blocks &&
      [...batches.values()].every(batch => batch.status === 'completed' && batch.explicit_completion_received === true && !batch.result?.error) &&
      summary?.complete === true && Array.isArray(summary.completion_blockers) && summary.completion_blockers.length === 0 &&
      events.every(e => !['extraction_error', 'source_invalidated', 'delivery_validation_rejected', 'workflow_error', 'run_deadline'].includes(e.type)) &&
      array(result.summary_attempts).at(-1)?.status === 'completed' && !array(result.summary_attempts).at(-1)?.error &&
      !ledger.halted && Array.isArray(ledger.requests) && ledger.requests.length > 0 && ledger.requests.length === result.ledger_totals?.requests &&
      delivery.schema_version === 'verbatim-figure-delivery-1' && delivery.document_id === run.document_id &&
      delivery.file_sha256 === metadata.file_sha256 && delivery.text_version === metadata.text_version &&
      Array.isArray(delivery.records) && (delivery.background_records === undefined || Array.isArray(delivery.background_records)) && delivered.length === result.candidate_count &&
      resultRecords.length === result.candidate_count && delivered.every(record => record.run_id === run.run_id && record.document_id === run.document_id &&
        resultRecords.some(v => v.record?.record_id === record.record_id && v.version === record.record_version && v.record.extraction_trace?.run_id === run.run_id) &&
        [...array(record.original_fragments), ...array(record.context_fragments)].every(fragment => fragment.text_version === metadata.text_version && !gaps.includes(fragment.block_id)))) {
      value = { rule_version: TASK_COMPLETION_RULE_VERSION, rule_origin: 'legacy_evidence_projection', processing_complete: true,
        source_gap_blocks: gaps.length, original_task_processing_complete: false, original_rule_version: 'legacy-task-completion-1' };
    }
    if (JSON.stringify(await identities()) !== JSON.stringify(before)) return undefined;
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(run.run_id, { key, value }); return value;
  }
}
