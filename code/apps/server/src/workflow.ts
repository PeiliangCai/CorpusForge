import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ContractError, ScopeSchema, assertSchema, defaultScope, type DeliveryReview, type EvidenceCatalog,
  type EvidenceRecord, type EvidenceSubmission, type EvidenceValidationContext, type EvidenceVersion, type FigureAssetCatalog,
  type RunInput, type Scope } from '@t1/contracts';
import { ExtractionStore, assertParsedDocument, createConfiguredPdfParserAdapter, discoverPdfFigures, assertLivePdfSource,
  buildArticleScope, buildSourceEvidenceUnits, taskSourceBlockIds, evidenceScopeIssues, buildEvidenceDelivery,
  allDeliveredRecords, assertFigureCatalog, validateEvidenceSubmission, exportEvidenceDelivery, buildSameSourceReviewIndex, evidenceDigest, confirmWholeFigure,
  type ExtractionDocument, type StoredEvidenceVersion } from '@t1/agent';
import type { WorkbenchCapabilities, WorkbenchEvent, WorkbenchExportKind, WorkbenchLabels, WorkbenchOutput, WorkbenchPaper,
  WorkbenchPaperDetail, WorkbenchRecord, WorkbenchRevisionInput, WorkbenchReviewInput, WorkbenchRun, WorkbenchSourceUnit, WorkbenchFigureCheckInput,
  WorkbenchRetention, WorkbenchRetentionInput, WorkbenchSubmission, WorkbenchModelProfile } from '../../../packages/contracts/src/workbench.js';
import { WorkbenchSources, type Artifact } from './workbench.js';
import { readingPassages } from './reading-passages.js';
import { WorkbenchModelsStore } from './workbench-models.js';
import { workbenchRunProgress, type ProgressCoverage } from './workbench-progress.js';
import { TASK_COMPLETION_RULE_VERSION, type WorkbenchTaskCompletion } from '../../../packages/contracts/src/workbench.js';
import { LegacyCompletionProjection, type LegacyCompletionMetadata } from './workflow-completion.js';
import { WorkbenchStorage } from './storage-management.js';

const CODE = fileURLToPath(new URL('../../../', import.meta.url));
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const terminals = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted']);
function taskTitle(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 500 || /[\x00-\x1f]/u.test(value)) throw new ContractError('invalid_task_title');
  return value.trim() || undefined;
}
function originalFilename(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > 240 || /[\x00-\x1f/\\]/u.test(value) || !/\.pdf$/iu.test(value)) throw new ContractError('invalid_original_filename');
  return value;
}
function submissionMetadata(value: unknown): WorkbenchSubmission | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('invalid_submission_metadata');
  const input = value as Record<string, unknown>, keys = Object.keys(input);
  if (input.kind === 'single' && keys.length === 1) return { kind: 'single' };
  if (input.kind === 'batch' && keys.length === 2 && keys.includes('batch_id') && typeof input.batch_id === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.batch_id)) return { kind: 'batch', batch_id: input.batch_id };
  throw new ContractError('invalid_submission_metadata');
}
export const unavailableMedicalCatalog: EvidenceCatalog = { catalog_version: 'medical-unavailable-1', status: 'unavailable', fixture: false,
  cancers: [], image_types: [], features: [], bindings: [] };
interface SourceSnapshot { document: ExtractionDocument; ir: Artifact; catalog?: FigureAssetCatalog; catalog_artifact?: Artifact; figure_history?: Artifact[] }
interface PaperRow { id: string; title: string; filename: string; pdf: Artifact; uploaded: boolean; language: string; pages: number;
  note: string; latest_source?: SourceSnapshot; uploaded_at?: string; last_uploaded_at?: string }
interface RunRow { id: string; paper_id: string; created_at: string; origin: WorkbenchOutput['origin']; controlled: boolean;
  task_title?: string; original_filename?: string;
  scope_catalog?: EvidenceCatalog;
  source?: SourceSnapshot; coverage?: unknown; error?: string; directory: string; strategy?: string; summary?: string;
  execution_started_at?: string; queue_wait_ms?: number; runtime_deadline?: string; finished_at?: string; submission?: WorkbenchSubmission; model_profile?: WorkbenchModelProfile }
interface Annotation { labels: WorkbenchLabels; deleted: boolean; reviewer: string; reason: string }
interface RunCleanupPlan { status: 'cleanup_pending' | 'complete'; batch_id?: string; targets: Array<{ path: string; parent: 'runs' | 'figure-reviews' | 'exports' }> }
interface BatchDeletion { members: Array<{ run_id: string; paper_id: string }> }
export interface WorkflowExecution {
  input: RunInput; document: ExtractionDocument; evidence_catalog?: EvidenceCatalog; catalog?: FigureAssetCatalog; directory: string;
  signal: AbortSignal; store: ExtractionStore; metadata: EvidenceValidationContext['metadata']; execution_started_at?: string;
  model_profile?: WorkbenchModelProfile;
}
export interface WorkflowRunner {
  /** Test dependency injection is server-owned. The HTTP client cannot select a runner or endpoint. */
  controlled: boolean; provider: string; model_id: string;
  public_runtime?: import('../../../packages/contracts/src/workbench.js').WorkbenchModelRuntime;
  default_model_profile?: WorkbenchModelProfile;
  available?(): boolean;
  /** Optional host admission hook, before parsing and outside any SQLite write transaction. */
  prepare?(input: RunInput, directory: string): void | Promise<void>;
  execute(context: WorkflowExecution): Promise<{ coverage?: unknown; summary?: string }>;
}
export interface WorkflowOptions {
  codeRoot?: string; directory?: string; sources?: WorkbenchSources | false; catalog?: EvidenceCatalog; catalogProvider?: () => EvidenceCatalog; runner?: WorkflowRunner;
  parse?: (input: RunInput, fileReference: string, directory: string, signal: AbortSignal) => Promise<ExtractionDocument>;
  /** Internal fixture may shorten the clock; production gets 30 min after taking an execution slot. */
  runTimeoutMs?: number;
  discover?: typeof discoverPdfFigures;
  /** Isolated storage tests only; production always uses the wall clock. */
  storageNow?: () => number;
}
export class WorkflowConflict extends ContractError {
  constructor(readonly current_version: number) { super('evidence_version_conflict'); }
}
export class WorkflowCatalogConflict extends ContractError {
  constructor(readonly current_catalog_sha256: string | null) { super('figure_catalog_version_conflict'); }
}
export class WorkflowRetentionConflict extends ContractError {
  constructor(readonly current_version: number, readonly current_retention_revision: number) { super('retention_revision_conflict'); }
}
export class WorkflowRunCleanupPending extends ContractError {
  constructor(readonly run_id: string, readonly paper_id: string) { super('run_deleted_cleanup_pending'); }
}
export class WorkflowBatchCleanupPending extends ContractError {
  constructor(readonly batch_id: string, readonly run_ids: string[]) { super('batch_deleted_cleanup_pending'); }
}

/** One coordinator owns short SQLite transactions. Parsing/model waits never hold a write transaction. */
export class WorkbenchWorkflow {
  readonly codeRoot: string; readonly directory: string; readonly catalog: EvidenceCatalog;
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private readonly preparingPapers = new Map<string, number>();
  private readonly deletingPapers = new Set<string>();
  private readonly pdfOperations = new Map<string, Promise<unknown>>();
  private readonly runWrites = new Map<string, number>();
  private cleanupFlight?: Promise<void>;
  private cleanupRetryRequested = false;
  private directCleanupCount = 0;
  readonly maxConcurrentRuns = 2;
  private executing = 0;
  private readonly queue: Array<{ id: string; controller: AbortController; run: () => Promise<void>; resolve: () => void; reject: (error: unknown) => void }> = [];
  private initialized?: Promise<void>; private shuttingDown = false;
  private readonly sourceUnitCache = new Map<string, WorkbenchSourceUnit[]>();
  private readonly outputCache = new Map<string, { key: string; value: WorkbenchOutput }>();
  private readonly progressEventsCache = new Map<string, { seq: number; events: WorkbenchEvent[] }>();
  private readonly requests = new Map<string, { hash: string; promise: Promise<unknown> }>();
  private readonly batchAdmissions = new Map<string, Promise<unknown>>();
  private readonly legacyCompletion: LegacyCompletionProjection;
  private readonly modelProfiles?: WorkbenchModelsStore;
  readonly storage: WorkbenchStorage;
  private storageCleanup = false;
  private storageMutations = 0;
  constructor(readonly store: ExtractionStore, readonly options: WorkflowOptions = {}) {
    this.codeRoot = resolve(options.codeRoot ?? CODE); this.directory = resolve(this.codeRoot, options.directory ?? 'runtime-data/workbench');
    this.legacyCompletion = new LegacyCompletionProjection(this.codeRoot);
    if (relative(this.codeRoot, this.directory).startsWith('..') || this.directory === this.codeRoot) throw new ContractError('workflow_directory_outside_code');
    this.catalog = structuredClone(options.catalog ?? unavailableMedicalCatalog);
    if (!Number.isSafeInteger(options.runTimeoutMs ?? 1800_000) || (options.runTimeoutMs ?? 1800_000) < 1 || (options.runTimeoutMs ?? 1800_000) > 1800_000) throw new ContractError('invalid_workflow_run_timeout');
    store.db.exec(`CREATE TABLE IF NOT EXISTS workbench_papers(id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_runs(id TEXT PRIMARY KEY REFERENCES s4_runs(id),paper_id TEXT NOT NULL REFERENCES workbench_papers(id),payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workbench_annotations(run_id TEXT NOT NULL,record_id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,record_id,version));
      CREATE TABLE IF NOT EXISTS workbench_reviews(run_id TEXT NOT NULL,record_id TEXT NOT NULL,version INTEGER NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,record_id,version));
      CREATE TABLE IF NOT EXISTS workbench_retentions(run_id TEXT NOT NULL REFERENCES s4_runs(id),record_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(run_id,record_id));
      CREATE TABLE IF NOT EXISTS workbench_exports(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,payload_json TEXT NOT NULL);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS workbench_deleted_sources(paper_id TEXT PRIMARY KEY,deleted_at TEXT NOT NULL)');
    store.db.exec("CREATE TABLE IF NOT EXISTS workbench_deleted_runs(run_id TEXT PRIMARY KEY,paper_id TEXT NOT NULL,deleted_at TEXT NOT NULL,payload_json TEXT NOT NULL DEFAULT '{}')");
    store.db.exec('CREATE TABLE IF NOT EXISTS workbench_deleted_batches(batch_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL)');
    // Persist only the identity of a successful submission, in the same transaction
    // as the paper/run. Keys survive deletions and never restart an old run.
    store.db.exec(`CREATE TABLE IF NOT EXISTS workbench_requests(operation TEXT NOT NULL,request_id TEXT NOT NULL,payload_sha256 TEXT NOT NULL,result_id TEXT NOT NULL,
      PRIMARY KEY(operation,request_id))`);
    if (options.runner?.default_model_profile) this.modelProfiles = new WorkbenchModelsStore(store, options.runner.default_model_profile);
    this.storage = new WorkbenchStorage({ codeRoot: this.codeRoot, directory: this.directory, store,
      busy: () => this.storageBusy(), now: options.storageNow,
      exclusive: async operation => {
        if (this.storageCleanup || this.storageBusy()) throw new ContractError('storage_busy');
        this.storageCleanup = true;
        try { return await operation(); }
        finally { this.storageCleanup = false; if (this.cleanupRetryRequested) void this.resumePendingRunCleanup().catch(() => {}); }
      },
      papersRemoved: ids => { for (const key of this.sourceUnitCache.keys()) if (ids.some(id => key.startsWith(id + ':'))) this.sourceUnitCache.delete(key); },
    });
  }
  private storageBusy() {
    if (this.shuttingDown || this.storageMutations > 0 || this.active.size > 0 || this.preparingPapers.size > 0 || this.deletingPapers.size > 0
      || this.pdfOperations.size > 0 || this.runWrites.size > 0 || this.directCleanupCount > 0 || Boolean(this.cleanupFlight) || this.batchAdmissions.size > 0 || this.requests.size > 0) return true;
    try { return this.runRows().some(row => !terminals.has(this.store.snapshot(row.id).state)); }
    catch { return true; } // Missing or unreadable run state can never grant cleanup admission.
  }
  private assertStorageWritable() { if (this.storageCleanup) throw new ContractError('storage_busy'); }
  private async withStorageMutation<T>(operation: () => Promise<T>): Promise<T> {
    this.assertStorageWritable(); this.storageMutations++;
    try { return await operation(); } finally { this.storageMutations--; }
  }
  async storageSummary() { await this.initialize(); return this.storage.summary(); }
  async storagePreview(body: unknown) { await this.initialize(); return this.storage.preview(body); }
  async storageCleanupSelection(body: unknown) { await this.initialize(); return this.storage.cleanup(body); }
  async initialize() { return this.initialized ??= this.initializeOnce(); }
  private async initializeOnce() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const row of this.runRows()) if (!terminals.has(this.store.snapshot(row.id).state)) {
      this.store.transition(row.id, 'interrupted'); this.store.event(row.id, 'interruption', { reason: 'server_restart', automatic_resume: false, saved_candidates_preserved: true });
    }
    if (this.options.sources !== false) {
      const sources = this.options.sources ?? new WorkbenchSources(this.codeRoot);
      for (const retained of await sources.retained(true)) {
        if (this.store.db.prepare('SELECT paper_id FROM workbench_deleted_sources WHERE paper_id=?').get(retained.row.id)) continue;
        const source: SourceSnapshot = { document: retained.document, ir: retained.row.ir, catalog: retained.catalog, catalog_artifact: retained.row.catalog };
        const paper: PaperRow = { id: retained.row.id, title: retained.row.metadata.title, filename: retained.row.id + '.pdf', pdf: retained.row.pdf,
          uploaded: false, language: retained.row.metadata.language, pages: retained.row.metadata.pages, note: retained.row.metadata.note, latest_source: source };
        const existing = this.store.db.prepare('SELECT id FROM workbench_papers WHERE id=?').get(paper.id);
        if (!existing) this.savePaper(paper);
        for (const output of retained.outputs) {
          const versions = output.result.versions ?? output.result.records;
          const first = versions[0]?.record;
          const id = first?.extraction_trace.run_id ?? output.result.run_id;
          if (!id) continue;
          if (this.store.db.prepare('SELECT run_id FROM workbench_deleted_runs WHERE run_id=?').get(id)) continue;
          if (this.store.db.prepare('SELECT id FROM workbench_runs WHERE id=?').get(id)) {
            const existingRun = this.run(id); if (!existingRun.strategy) this.saveRun({ ...existingRun, strategy: output.strategy });
            continue;
          }
          const input: RunInput = { schema_version: '1', run_id: id, document_id: paper.id, file_sha256: paper.pdf.sha256, fixture: retained.document.fixture,
            scope: first?.extraction_trace.scope ?? output.result.scope ?? defaultScope(this.catalog.catalog_version), rule_version: first?.extraction_trace.rule_version ?? 'visual-statements-2',
            runtime_profile: { provider: first?.extraction_trace.provider ?? 'retained', model_id: first?.extraction_trace.model_id ?? 'retained', endpoint: '', pi_version: '1.4.0', version: 'retained-workbench-import-1' } };
          this.store.atomic(() => {
            this.store.create(input, { historical: true, medical_quality_approved: false });
            this.store.retainVersions(id, versions);
            this.store.db.prepare('UPDATE s4_runs SET state=? WHERE id=?').run(terminals.has(output.result.state) ? output.result.state : 'interrupted', id);
            this.saveRun({ id, paper_id: paper.id, source, origin: 'historical_compatibility_replay', controlled: false, created_at: now(), directory: '', coverage: output.result.coverage, strategy: output.strategy, summary: output.result.summary });
            // Importing a newer retained source updates the paper view only when no workbench run has replaced it.
            if (!this.runRows().some(r => r.paper_id === paper.id && r.origin !== 'historical_compatibility_replay')) this.savePaper(paper);
          });
        }
      }
    }
    // This resumes only existing deletion plans; it does not await initialization
    // or active coordinators, so startup cannot depend on itself.
    await this.resumePendingRunCleanup();
  }
  capabilities(): WorkbenchCapabilities {
    const runtime = this.options.runner?.controlled ? undefined : this.options.runner?.public_runtime;
    return { schema_version: 't1-workbench-capabilities-1', read_only: false, paper_upload: true,
      extraction_start: Boolean(this.options.runner && (this.options.runner.available?.() ?? true)), persisted_review: true, approved_export: true, persisted_retention: true, retained_export: true,
      backend_pi_sdk: '1.4.0', controlled_fixture: this.options.runner?.controlled ?? false, max_concurrent_runs: this.maxConcurrentRuns, model_selection: Boolean(this.modelProfiles),
      max_pdf_bytes: MAX_PDF_BYTES, ...(runtime ? { model_runtime: { provider: runtime.provider, model_id: runtime.model_id,
        reasoning_effort: runtime.reasoning_effort, limits: { requests: runtime.limits.requests, input_tokens: runtime.limits.input_tokens,
          output_tokens: runtime.limits.output_tokens, execution_seconds: Math.min(runtime.limits.execution_seconds, (this.options.runTimeoutMs ?? 1800_000) / 1000) } } } : {}),
      ...(!this.options.runner ? { extraction_unavailable_reason: 'server_model_not_enabled' } : {}) };
  }
  models() { return this.modelProfiles?.list() ?? { provider: '', default_profile_id: null, profiles: [] }; }
  addModel(value: unknown) {
    if (!this.modelProfiles) throw new ContractError('model_selection_unavailable');
    const profile = this.modelProfiles.add(value); return { profile, ...this.modelProfiles.list() };
  }
  private currentScopeCatalog() { return structuredClone(this.options.catalogProvider?.() ?? this.catalog); }
  scopeCatalog() { const catalog = this.currentScopeCatalog(), available = ['approved', 'operator_configured'].includes(catalog.status) && !catalog.fixture;
    return { ...catalog, default_scope: { ...defaultScope(catalog.catalog_version), matching_policy_version: 'exact-explicit-synonyms-1' },
      restricted_available: available, restricted_reason: available ? null : 'medical_catalog_not_approved', development_only: catalog.status === 'development_only' || catalog.fixture }; }
  private paper(id: string): PaperRow {
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_papers WHERE id=?').get(id);
    if (!row) throw new ContractError('workbench_paper_not_found'); return JSON.parse(row.payload_json as string);
  }
  private run(id: string): RunRow {
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(id);
    if (!row) throw new ContractError('workbench_run_not_found'); return JSON.parse(row.payload_json as string);
  }
  private runRows(): RunRow[] { return this.store.db.prepare('SELECT payload_json FROM workbench_runs ORDER BY rowid DESC').all().map(r => JSON.parse(r.payload_json as string)); }
  private savePaper(row: PaperRow) { this.store.db.prepare('INSERT INTO workbench_papers VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(row.id, JSON.stringify(row)); }
  private saveRun(row: RunRow) { this.store.db.prepare('INSERT INTO workbench_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json').run(row.id, row.paper_id, JSON.stringify(row)); }
  private summary(row: PaperRow): WorkbenchPaper { return { id: row.id, title: row.title, sha256: row.pdf.sha256, uploaded: row.uploaded, filename: row.filename,
    language: row.language, pages: row.pages, note: row.note, output_ids: this.store.db.prepare('SELECT id FROM workbench_runs WHERE paper_id=? ORDER BY rowid DESC').all(row.id).map(r => r.id as string) }; }
  async papers() { await this.initialize(); return this.store.db.prepare('SELECT payload_json FROM workbench_papers ORDER BY rowid DESC').all().map(r => this.summary(JSON.parse(r.payload_json as string))); }
  private progressEvents(id: string) {
    const seq = Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM s4_events WHERE run_id=?').get(id)!.seq);
    const cached = this.progressEventsCache.get(id); if (cached?.seq === seq) return cached.events;
    // Read only progress fields; never copy full prompts, tool arguments, candidate text or request ledgers into the run list.
    const rows = this.store.db.prepare(`SELECT seq,json_extract(payload_json,'$.type','$.timestamp','$.detail.state','$.detail.status','$.detail.batch_id',
      '$.detail.assigned_block_ids','$.detail.dispatched_blocks','$.detail.total_batches','$.detail.source_glyph_quarantined_block_ids',
      '$.detail.source_gap_blocks','$.detail.complete','$.detail.explicit_completion_received','$.detail.progress_unit','$.detail.total_paragraphs','$.detail.completed_paragraph_ids',
      '$.detail.total_content_units','$.detail.completed_content_unit_ids','$.detail.input_unit_counts','$.detail.explicitly_completed_input_unit_counts',
      '$.detail.batch_index','$.detail.activity') p FROM s4_events
      WHERE run_id=? AND seq>? AND json_extract(payload_json,'$.type') IN
      ('state','coverage_inventory','batch','batch_started','batch_failed','run_activity','document_summary','source_parse_started','source_parse_completed','figure_discovery_started','figure_discovery_completed','source_saved','run_result_saved') ORDER BY seq`).all(id, cached?.seq ?? 0);
    const events = [...(cached?.events ?? []), ...rows.map(row => {
      const [type, timestamp, state, status, batch_id, assigned_block_ids, dispatched_blocks, total_batches, source_glyph_quarantined_block_ids,
        source_gap_blocks, complete, explicit_completion_received, progress_unit, total_paragraphs, completed_paragraph_ids, total_content_units, completed_content_unit_ids, input_unit_counts, explicitly_completed_input_unit_counts, batch_index, activity] = JSON.parse(row.p as string);
      return { run_id: id, seq: Number(row.seq), type, timestamp,
        detail: { state, status, batch_id, assigned_block_ids, dispatched_blocks, total_batches, source_glyph_quarantined_block_ids, source_gap_blocks, complete, explicit_completion_received, progress_unit, total_paragraphs, completed_paragraph_ids,
          total_content_units, completed_content_unit_ids, input_unit_counts, explicitly_completed_input_unit_counts, batch_index, activity } } as WorkbenchEvent;
    })];
    if (this.progressEventsCache.size >= 100) this.progressEventsCache.delete(this.progressEventsCache.keys().next().value!);
    this.progressEventsCache.set(id, { seq, events }); return events;
  }
  async runs(filterId?: string): Promise<WorkbenchRun[]> { await this.initialize();
    return Promise.all(this.store.db.prepare(`SELECT w.id,w.paper_id,s.state,s.input_json,json_extract(w.payload_json,'$.origin','$.created_at','$.controlled','$.error','$.execution_started_at','$.queue_wait_ms','$.runtime_deadline','$.finished_at','$.submission','$.model_profile','$.scope_catalog','$.task_title','$.original_filename',
      '$.coverage.explicitly_completed_source_blocks','$.coverage.dispatched_source_blocks','$.coverage.whole_document_summary_complete','$.coverage.task_processing_complete',
      '$.coverage.task_completion_rule_version','$.coverage.delivery_validation_status','$.coverage.progress_unit','$.coverage.explicitly_completed_paragraphs','$.coverage.dispatched_paragraphs',
      '$.coverage.explicitly_completed_content_units','$.coverage.dispatched_content_units','$.coverage.input_unit_counts','$.coverage.explicitly_completed_input_unit_counts','$.coverage.task_processing_blockers') info,
      json_array_length(json_extract(w.payload_json,'$.coverage.source_glyph_quarantined_block_ids')) source_gap_blocks
      FROM workbench_runs w JOIN s4_runs s ON w.id=s.id ${filterId ? 'WHERE w.id=?' : ''} ORDER BY w.rowid DESC`).all(...(filterId ? [filterId] : [])).map(async row => {
      const [origin, created_at, controlled, error, execution_started_at, queue_wait_ms, runtime_deadline, finished_at, submission, model_profile, scope_catalog, task_title, original_filename,
        completed, total, summary_completed, task_processing_complete, completionRule, deliveryStatus, progressUnit, completedParagraphs, totalParagraphs, completedContent, totalContent, unitCounts, completedUnitCounts, taskBlockers] = JSON.parse(row.info as string), input = JSON.parse(row.input_json as string) as RunInput;
      const count = this.store.db.prepare(`SELECT COUNT(*) n FROM s4_versions v JOIN
        (SELECT record_id,MAX(version) version FROM s4_versions WHERE run_id=? AND COALESCE(json_extract(envelope_json,'$.status'),'active')<>'proposed' GROUP BY record_id) current
        ON v.record_id=current.record_id AND v.version=current.version
        LEFT JOIN workbench_annotations a ON a.run_id=v.run_id AND a.record_id=v.record_id AND a.version=v.version
        WHERE v.run_id=? AND COALESCE(json_extract(a.payload_json,'$.deleted'),0)<>1`).get(row.id as string, row.id as string)!;
      const ready = Boolean(finished_at) || !this.active.has(row.id as string), rawState = row.state as string;
      const run: WorkbenchRun = { run_id: row.id as string, document_id: row.paper_id as string, state: ['completed', 'partial'].includes(rawState) && !ready ? 'reconciling' : rawState, fixture: Boolean(controlled), candidate_count: Number(count.n),
        scope: input.scope, ...(scope_catalog ? { scope_catalog } : {}), origin, created_at, provider: input.runtime_profile.provider, model_id: input.runtime_profile.model_id,
        ...(typeof task_title === 'string' ? { task_title } : {}), ...(typeof original_filename === 'string' ? { original_filename } : {}),
        ...(typeof task_processing_complete === 'boolean' ? { task_processing_complete } : {}),
        ...(model_profile ? { model_profile } : {}), result_ready: terminals.has(rawState) && ready, ...(submission ? { submission } : {}), ...(finished_at ? { finished_at } : {}), ...(error ? { error } : {}), ...(execution_started_at ? { execution_started_at, queue_wait_ms, runtime_deadline } : {}) };
      const coverage: ProgressCoverage = { ...(typeof completed === 'number' ? { completed } : {}), ...(typeof total === 'number' ? { total } : {}),
        ...(Array.isArray(taskBlockers) ? { task_processing_blockers: taskBlockers } : {}),
        ...(progressUnit === 'paragraphs' ? { unit: 'paragraphs', ...(typeof completedParagraphs === 'number' ? { completed: completedParagraphs } : {}), ...(typeof totalParagraphs === 'number' ? { total: totalParagraphs } : {}) } : {}),
        ...(progressUnit === 'content_units' ? { unit: 'content_units', ...(typeof completedContent === 'number' ? { completed: completedContent } : {}), ...(typeof totalContent === 'number' ? { total: totalContent } : {}),
          ...(unitCounts && typeof unitCounts === 'object' ? { unit_counts: unitCounts } : {}), ...(completedUnitCounts && typeof completedUnitCounts === 'object' ? { completed_unit_counts: completedUnitCounts } : {}) } : {}),
        ...(typeof summary_completed === 'boolean' || summary_completed === 0 || summary_completed === 1 ? { summary_completed: Boolean(summary_completed) } : {}),
        ...(typeof row.source_gap_blocks === 'number' ? { source_gap_blocks: row.source_gap_blocks } : {}) };
      const taskCompletion = await this.completionProjection(run, input, completionRule, deliveryStatus, coverage.source_gap_blocks ?? 0);
      return { ...run, ...(taskCompletion ? { task_completion: taskCompletion } : {}), progress: workbenchRunProgress(run, this.progressEvents(run.run_id), coverage) };
    }));
  }
  private async completionProjection(run: WorkbenchRun, input: RunInput, rule: unknown, delivery: unknown, sourceGaps: number): Promise<WorkbenchTaskCompletion | undefined> {
    if (rule === TASK_COMPLETION_RULE_VERSION && typeof run.task_processing_complete === 'boolean') return {
      rule_version: rule, rule_origin: 'persisted', processing_complete: run.task_processing_complete && delivery === 'passed' && run.result_ready === true &&
        Boolean(run.finished_at) && ['completed', 'partial'].includes(run.state) && !run.error && Boolean(this.store.db.prepare(`SELECT 1 FROM s4_events
          WHERE run_id=? AND json_extract(payload_json,'$.type')='run_result_saved' AND json_extract(payload_json,'$.detail.finalization_complete')=1
          AND json_extract(payload_json,'$.detail.coverage_saved')=1 LIMIT 1`).get(run.run_id)), source_gap_blocks: sourceGaps,
      original_task_processing_complete: run.task_processing_complete,
    };
    if (rule || run.task_processing_complete !== false || run.result_ready !== true || !run.finished_at || run.error || !['completed', 'partial'].includes(run.state) || !sourceGaps) return undefined;
    // Small metadata only. The full legacy row/IR/result is decoded solely on a
    // cache miss after its evidence files have been identified.
    const row = this.store.db.prepare(`SELECT json_extract(w.payload_json,'$.directory','$.source.ir','$.source.document.document_id',
      '$.source.document.file_sha256','$.source.document.text_version','$.coverage.task_processing_blockers') info,
      json_extract(p.payload_json,'$.pdf') pdf FROM workbench_runs w JOIN workbench_papers p ON p.id=w.paper_id WHERE w.id=?`).get(run.run_id);
    if (!row) return undefined;
    const [directory, ir, document_id, file_sha256, text_version, blockers] = JSON.parse(row.info as string);
    if (file_sha256 !== input.file_sha256) return undefined;
    const proof = this.store.db.prepare(`SELECT MAX(seq) event_seq,
      SUM(CASE WHEN json_extract(payload_json,'$.type')='run_result_saved' AND json_extract(payload_json,'$.detail.finalization_complete')=1 AND json_extract(payload_json,'$.detail.coverage_saved')=1 THEN 1 ELSE 0 END) saved,
      SUM(CASE WHEN json_extract(payload_json,'$.type') IN ('extraction_error','source_invalidated','delivery_validation_rejected','workflow_error','run_deadline','interruption') THEN 1 ELSE 0 END) unsafe
      FROM s4_events WHERE run_id=?`).get(run.run_id)!;
    const metadata: LegacyCompletionMetadata = { directory, ir, document_id, file_sha256, text_version, blockers,
      pdf: JSON.parse(row.pdf as string), event_seq: Number(proof.event_seq), result_saved: Number(proof.saved) > 0, unsafe_events: Number(proof.unsafe) };
    return this.legacyCompletion.project(run, metadata, () => this.run(run.run_id).coverage);
  }
  private async readPinned(artifact: Artifact) {
    const root = await realpath(this.codeRoot), path = await realpath(resolve(root, artifact.path)).catch(() => { throw new ContractError('source_file_missing'); });
    const rel = relative(root, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('source_file_outside_code');
    const bytes = await readFile(path);
    if (digest(bytes) !== artifact.sha256) throw new ContractError('source_sha_mismatch'); return bytes;
  }
  private async sourceIssues(paper: PaperRow, source?: SourceSnapshot) {
    const issues: string[] = [];
    try { await this.readPinned(paper.pdf); } catch (e) { issues.push('pdf_' + (e instanceof ContractError ? e.code : 'unavailable')); }
    if (source) {
      try { await this.readPinned(source.ir); } catch (e) { issues.push('ir_' + (e instanceof ContractError ? e.code : 'unavailable')); }
      if (source.document.document_id !== paper.id || source.document.file_sha256 !== paper.pdf.sha256) issues.push('source_document_binding_mismatch');
      if (source.catalog && (source.catalog.document_id !== paper.id || source.catalog.file_sha256 !== paper.pdf.sha256 || source.catalog.text_version !== source.document.text_version)) issues.push('figure_source_binding_mismatch');
    }
    return issues;
  }
  private async requireSource(paper: PaperRow, source?: SourceSnapshot) { const issues = await this.sourceIssues(paper, source); if (issues.length) throw new ContractError('source_integrity_blocked:' + issues.join(',')); }
  private async submission<T>(operation: 'upload' | 'start', requestId: string | undefined, payload: unknown,
    existing: (id: string) => Promise<T> | T, create: (remember: (id: string) => void) => Promise<T>): Promise<T> {
    if (requestId === undefined) return create(() => {});
    if (!/^[A-Za-z0-9_-]{8,120}$/u.test(requestId)) throw new ContractError('invalid_submission_request_id');
    const hash = digest(Buffer.from(canonical(payload))), key = operation + ':' + requestId;
    const saved = this.store.db.prepare('SELECT payload_sha256,result_id FROM workbench_requests WHERE operation=? AND request_id=?').get(operation, requestId);
    if (saved) {
      if (saved.payload_sha256 !== hash) throw new ContractError('submission_payload_conflict');
      const table = operation === 'upload' ? 'workbench_papers' : 'workbench_runs';
      if (!this.store.db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(saved.result_id as string)) throw new ContractError('submission_result_deleted');
      return existing(saved.result_id as string);
    }
    const flight = this.requests.get(key);
    if (flight) {
      if (flight.hash !== hash) throw new ContractError('submission_payload_conflict');
      return flight.promise as Promise<T>;
    }
    if (this.requests.size >= 64) throw new ContractError('submission_busy');
    const remember = (id: string) => this.store.db.prepare('INSERT INTO workbench_requests VALUES(?,?,?,?)').run(operation, requestId, hash, id);
    const promise = create(remember); this.requests.set(key, { hash, promise });
    try { return await promise; } finally { if (this.requests.get(key)?.promise === promise) this.requests.delete(key); }
  }
  /** Content-addressed PDF writes and last-reference removal share one short queue. */
  private async withPdfFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const key = resolve(path), previous = this.pdfOperations.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.pdfOperations.set(key, current);
    try { return await current; }
    finally { if (this.pdfOperations.get(key) === current) this.pdfOperations.delete(key); }
  }
  private pdfContentPath(hash: string) { return resolve(this.directory, 'pdf', hash + '.pdf'); }
  /** Always acquire content identity before a retained/legacy artifact path. */
  private async withPdfArtifact<T>(pdf: Artifact, operation: () => Promise<T>): Promise<T> {
    const content = this.pdfContentPath(pdf.sha256), path = resolve(this.codeRoot, pdf.path);
    return this.withPdfFile(content, () => path === content ? operation() : this.withPdfFile(path, operation));
  }
  /** Concurrent first members cannot establish different snapshots for the same batch. */
  private async withBatchAdmission<T>(submission: WorkbenchSubmission | undefined, operation: () => Promise<T>): Promise<T> {
    if (submission?.kind !== 'batch') return operation();
    const key = submission.batch_id, previous = this.batchAdmissions.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation); this.batchAdmissions.set(key, current);
    try { return await current; } finally { if (this.batchAdmissions.get(key) === current) this.batchAdmissions.delete(key); }
  }
  /** Deletion never races a pending source check, export, or human write. */
  private async withRunWrite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    this.assertStorageWritable();
    const row = this.run(id);
    if (this.deletingPapers.has(row.paper_id)) throw new ContractError('paper_deletion_in_progress');
    this.runWrites.set(id, (this.runWrites.get(id) ?? 0) + 1);
    try { return await operation(); }
    finally {
      const remaining = this.runWrites.get(id)! - 1;
      if (remaining) this.runWrites.set(id, remaining); else this.runWrites.delete(id);
      void this.resumePendingRunCleanup().catch(() => {});
    }
  }
  async upload(bytes: Buffer, filename: string, title?: string, requestId?: string) {
    await this.initialize();
    return this.withStorageMutation(() => this.performUpload(bytes, filename, title, requestId));
  }
  private async performUpload(bytes: Buffer, filename: string, title?: string, requestId?: string) {
    if (!filename || filename.length > 240 || /[\x00-\x1f/\\]/u.test(filename) || !/\.pdf$/iu.test(filename)) throw new ContractError('invalid_pdf_filename');
    if (!bytes.length || bytes.length > MAX_PDF_BYTES) throw new ContractError('pdf_size_out_of_bounds');
    if (!bytes.subarray(0, 8).toString('ascii').startsWith('%PDF-') || !bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF'))) throw new ContractError('invalid_pdf_bytes');
    if (title !== undefined && (title.length > 500 || /[\x00-\x1f]/u.test(title))) throw new ContractError('invalid_paper_title');
    const hash = digest(bytes);
    return this.submission('upload', requestId, { sha256: hash, filename, title: title?.trim() || '' },
      id => { const paper = this.paper(id); this.savePaper({ ...paper, last_uploaded_at: now() }); return { paper: this.summary(paper), reused: true }; }, async remember => {
    const id = 'paper-' + randomUUID(), path = this.pdfContentPath(hash);
    return this.withPdfFile(path, async () => {
    const saved = this.store.db.prepare("SELECT payload_json FROM workbench_papers WHERE json_extract(payload_json,'$.pdf.sha256')=? ORDER BY rowid LIMIT 1").get(hash);
    if (saved) {
      const candidate = JSON.parse(saved.payload_json as string) as PaperRow;
      const reuse = async () => {
        if (this.deletingPapers.has(candidate.id)) throw new ContractError('paper_deletion_in_progress');
        await this.requireSource(candidate);
        if (this.deletingPapers.has(candidate.id)) throw new ContractError('paper_deletion_in_progress');
        const current = this.paper(candidate.id);
        this.store.atomic(() => { this.savePaper({ ...current, last_uploaded_at: now() }); remember(current.id); });
        return { paper: this.summary(current), reused: true };
      };
      const candidatePath = resolve(this.codeRoot, candidate.pdf.path);
      return candidatePath === path ? reuse() : this.withPdfFile(candidatePath, reuse);
    }
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try { await writeFile(path, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || digest(await readFile(path)) !== hash) throw error; }
    const row: PaperRow = { id, title: title?.trim() || filename, filename, pdf: { path: relative(this.codeRoot, path), sha256: hash }, uploaded: true,
      language: 'und', pages: 0, note: 'Uploaded PDF; parsing and medical content remain unverified.', uploaded_at: now(), last_uploaded_at: now() };
    this.store.atomic(() => { this.savePaper(row); remember(id); }); return { paper: this.summary(row), reused: false };
    });
    });
  }
  async restorePdf(id: string, bytes: Buffer) {
    await this.initialize(); return this.withStorageMutation(() => this.performRestorePdf(id, bytes));
  }
  private async performRestorePdf(id: string, bytes: Buffer) {
    const paper = this.paper(id);
    if (bytes.length > MAX_PDF_BYTES || digest(bytes) !== paper.pdf.sha256) throw new ContractError('restore_requires_identical_pdf');
    const path = resolve(this.codeRoot, paper.pdf.path), rel = relative(this.codeRoot, path);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ContractError('source_file_outside_code');
    return this.withPdfArtifact(paper.pdf, async () => {
    if (this.deletingPapers.has(id)) throw new ContractError('paper_deletion_in_progress');
    this.paper(id); // The paper may have been removed while waiting for this PDF.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, bytes, { mode: 0o600 });
    this.savePaper({ ...this.paper(id), last_uploaded_at: now() });
    return { restored: true, sha256: paper.pdf.sha256 };
    });
  }
  private units(document: ExtractionDocument, sourceGlyphPolicyVersion?: string): WorkbenchSourceUnit[] {
    const key = `${document.document_id}:${document.file_sha256}:${document.text_version}:${sourceGlyphPolicyVersion ?? 'legacy'}`;
    let units = this.sourceUnitCache.get(key);
    if (!units) { units = buildSourceEvidenceUnits(document, sourceGlyphPolicyVersion).map(unit => ({ ...unit, text: unit.segments.map(s => s.exact_quote).join('\n') })); this.sourceUnitCache.set(key, units); }
    return units;
  }
  private annotation(runId: string, version: EvidenceVersion): Annotation {
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_annotations WHERE run_id=? AND record_id=? AND version=?').get(runId, version.record.record_id, version.version);
    return row ? JSON.parse(row.payload_json as string) : { labels: {}, deleted: false, reviewer: '', reason: '' };
  }
  private review(runId: string, version: EvidenceVersion): DeliveryReview | undefined {
    const row = this.store.db.prepare('SELECT payload_json FROM workbench_reviews WHERE run_id=? AND record_id=? AND version=?').get(runId, version.record.record_id, version.version);
    return row ? JSON.parse(row.payload_json as string) : undefined;
  }
  private retention(runId: string, version: EvidenceVersion): WorkbenchRetention {
    const recordId = version.record.record_id;
    const saved = this.store.db.prepare('SELECT payload_json FROM workbench_retentions WHERE run_id=? AND record_id=?').get(runId, recordId);
    if (saved) return JSON.parse(saved.payload_json as string);
    // Only the latest explicit historical decision applies. A later pending/approve
    // reverses a rejection, while editing labels/source alone never restores it.
    const latest = this.store.db.prepare('SELECT payload_json FROM workbench_reviews WHERE run_id=? AND record_id=? AND version<=? ORDER BY version DESC LIMIT 1').get(runId, recordId, version.version);
    if (latest) {
      const review = JSON.parse(latest.payload_json as string) as DeliveryReview;
      return { status: review.decision === 'rejected' ? 'excluded' : 'kept', revision: 0, origin: 'legacy_review', record_version: review.record_version };
    }
    const legacy = this.store.db.prepare(`SELECT envelope_json FROM s4_versions WHERE run_id=? AND record_id=? AND version<=?
      AND json_extract(envelope_json,'$.actor')='human' AND json_extract(envelope_json,'$.record.review_status') IN ('approved','rejected')
      AND COALESCE(json_extract(envelope_json,'$.status'),'active')<>'proposed' ORDER BY version DESC LIMIT 1`).get(runId, recordId, version.version);
    if (legacy) { const value = JSON.parse(legacy.envelope_json as string) as EvidenceVersion;
      return { status: value.record.review_status === 'rejected' ? 'excluded' : 'kept', revision: 0, origin: 'legacy_review', record_version: value.version }; }
    return { status: 'kept', revision: 0, origin: 'default', record_version: version.version };
  }
  private visibleVersions(id: string) { return this.store.current(id).filter(v => !this.annotation(id, v).deleted); }
  private async availableCatalog(source: SourceSnapshot) {
    if (!source.catalog) return undefined;
    const catalog = structuredClone(source.catalog);
    if (source.catalog_artifact) {
      try { await this.readPinned(source.catalog_artifact); }
      catch { for (const f of catalog.figures) { f.regions = []; f.verification.status = 'needs_review'; f.verification.notes += ' Figure catalog source unavailable or changed.'; } return catalog; }
    }
    for (const figure of catalog.figures) {
      const kept = [];
      for (const asset of figure.regions) { try { await this.readPinned(asset); kept.push(asset); } catch { /* text remains available */ } }
      if (kept.length !== figure.regions.length) { figure.regions = kept; figure.verification.status = 'needs_review'; figure.verification.notes += ' One or more original Figure assets unavailable or changed.'; }
    }
    return catalog;
  }
  private async output(row: RunRow): Promise<WorkbenchOutput> {
    row = this.run(row.id);
    const raw = this.store.db.prepare('SELECT input_json,state FROM s4_runs WHERE id=?').get(row.id)!;
    const snapshot = { input: JSON.parse(raw.input_json as string) as RunInput, state: raw.state as string }, source = row.source;
    if (!source) return { id: row.id, strategy: row.strategy ?? 'B0', state: snapshot.state, origin: row.origin, records: [], fixture: row.controlled,
      result_ready: terminals.has(snapshot.state) && (Boolean(row.finished_at) || !this.active.has(row.id)),
      full_recall_claimed: false, medical_quality_approved: false, scope: snapshot.input.scope, ...(row.scope_catalog ? { scope_catalog: row.scope_catalog } : {}), error: row.error };
    const catalog = await this.availableCatalog(source), latest = this.run(row.id);
    if (latest.source?.ir.sha256 !== source.ir.sha256 || latest.source?.catalog_artifact?.sha256 !== source.catalog_artifact?.sha256) return this.output(latest);
    row = latest;
    const currentState = this.store.db.prepare('SELECT state FROM s4_runs WHERE id=?').get(row.id)!.state as string, ready = Boolean(row.finished_at) || !this.active.has(row.id);
    snapshot.state = ['completed', 'partial'].includes(currentState) && !ready ? 'reconciling' : currentState;
    const seq = Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM s4_events WHERE run_id=?').get(row.id)!.seq);
    const metadataKey = evidenceDigest({ coverage: row.coverage ?? null, summary: row.summary ?? null, error: row.error ?? null, finished_at: row.finished_at ?? null });
    const cacheKey = `${seq}:${snapshot.state}:${ready}:${metadataKey}:${source.ir.sha256}:${evidenceDigest(catalog ?? null)}`;
    const cached = this.outputCache.get(row.id); if (cached?.key === cacheKey) return cached.value;
    const versions = this.visibleVersions(row.id), delivery = buildEvidenceDelivery(source.document, versions, catalog), units = this.units(source.document, (row.coverage as { source_glyph_policy_version?: string } | undefined)?.source_glyph_policy_version);
    const records: WorkbenchRecord[] = allDeliveredRecords(delivery).map(value => {
      const version = versions.find(v => v.record.record_id === value.record_id)!, annotation = this.annotation(row.id, version), review = this.review(row.id, version);
      const textApproved = Boolean(review?.decision === 'approved' && review.record_version === value.record_version && review.text_fingerprint === value.text_fingerprint);
      const figuresApproved = textApproved && review?.review_scope === 'text_and_figures' && review.delivery_fingerprint === value.delivery_fingerprint;
      const unitIds = (fragments: typeof value.original_fragments) => units.filter(u => u.segments.every(s => fragments.some(f => f.block_id === s.block_id && f.start <= s.start && f.end >= s.end))).map(u => u.unit_id);
      return { id: value.record_id, version: value.record_version, run_id: row.id, actor: version.actor, fragments: value.original_fragments, context: value.context_fragments,
        passages: readingPassages(source.document, value.original_fragments, units), context_passages: readingPassages(source.document, value.context_fragments, units), retention: this.retention(row.id, version),
        association: value.figure_association.status, figure_ids: value.figure_association.figure_ids, proposed_figure_ids: value.figure_association.proposed_figure_ids,
        reasons: value.figure_association.reasons, review_status: review?.decision === 'rejected' ? 'rejected' : textApproved ? figuresApproved ? 'approved_text_and_figures' : 'approved_text_only' : 'pending',
        text_fingerprint: value.text_fingerprint, delivery_fingerprint: value.delivery_fingerprint, labels: annotation.labels,
        text_approved: textApproved, figures_approved: figuresApproved, review_reason: review?.reason ?? '', source_unit_ids: unitIds(value.original_fragments), context_unit_ids: unitIds(value.context_fragments),
        evidence_role: annotation.labels.evidence_role ?? value.primary_assessment?.effective_role ?? 'primary_candidate', model_primary_assessment: value.primary_assessment?.value ?? null,
        ...(value.supporting_table_evidence?.length ? { supporting_table_evidence: value.supporting_table_evidence } : {}) };
    });
    const value: WorkbenchOutput = { id: row.id, strategy: row.strategy ?? 'B0', state: snapshot.state, origin: row.origin, records, fixture: row.controlled, scope: snapshot.input.scope,
      ...(row.scope_catalog ? { scope_catalog: row.scope_catalog } : {}),
      result_ready: terminals.has(currentState) && ready,
      ...(row.summary ? { summary: row.summary, summary_is_diagnostic: true as const } : {}),
      full_recall_claimed: false, medical_quality_approved: false, coverage: row.coverage, same_source_review_index: buildSameSourceReviewIndex(versions), ...(row.error ? { error: row.error } : {}) };
    const gapIds = new Set((row.coverage as { source_glyph_quarantined_block_ids?: string[] } | undefined)?.source_glyph_quarantined_block_ids ?? []);
    value.source_gaps = source.document.blocks.filter(block => gapIds.has(block.block_id)).map(block => ({ block_id: block.block_id,
      physical_page: block.page, text_version: block.text_version, original_text: block.text,
      uncertain_spans: (block.source_glyph_issues ?? []).map(issue => ({ start: issue.start, end: issue.end, code: issue.code })) }));
    this.outputCache.set(row.id, { key: cacheKey, value }); return value;
  }
  async detail(id: string): Promise<WorkbenchPaperDetail> {
    await this.initialize(); const paper = this.paper(id), source = paper.latest_source, issues = await this.sourceIssues(paper, source);
    const catalog = source ? await this.availableCatalog(source) : undefined;
    return { paper: this.summary(paper), text_version: source?.document.text_version ?? '', pdf_url: `/api/t1/workbench/papers/${id}/pdf`, source_verified: issues.length === 0,
      source_status: issues.length ? issues.some(i => i.includes('missing')) ? 'missing' : 'mismatch' : source ? 'valid' : 'not_parsed', source_issues: issues,
      read_only: false, source_units: source ? this.units(source.document) : [],
      figures: (catalog?.figures ?? []).map(f => ({ id: f.figure_id, number: f.figure_number, verification: f.verification.status, caption: f.caption_segments, caption_passages: readingPassages(source!.document, f.caption_segments, this.units(source!.document)), human_approved: false,
        assets: f.regions.map(a => ({ id: a.asset_id, url: `/api/t1/workbench/papers/${id}/figures/${a.asset_id}`, sha256: a.sha256, page: a.physical_page, width: a.width_px, height: a.height_px })) })),
      outputs: await Promise.all(this.runRows().filter(r => r.paper_id === id).map(async r => ({ ...await this.output(r), task_completion: (await this.runs(r.id))[0]?.task_completion }))) };
  }
  async runDetail(id: string) { await this.initialize(); const row = this.run(id), paper = this.paper(row.paper_id), source = row.source, issues = await this.sourceIssues(paper, source), catalog = source ? await this.availableCatalog(source) : undefined;
    const rawOutput = await this.output(row), currentRun = (await this.runs(id))[0]!;
    const output = { ...rawOutput, task_completion: currentRun.task_completion };
    return { run: { ...currentRun, state: output.state, candidate_count: output.records.length, result_ready: output.result_ready }, output, source_units: source ? this.units(source.document, (row.coverage as { source_glyph_policy_version?: string } | undefined)?.source_glyph_policy_version) : [], source_issues: issues,
      figures: (catalog?.figures ?? []).map(f => ({ id: f.figure_id, number: f.figure_number, verification: f.verification.status, caption: f.caption_segments,
        caption_passages: readingPassages(source!.document, f.caption_segments, this.units(source!.document)), human_approved: false as const,
        assets: f.regions.map(a => ({ id: a.asset_id, url: `/api/t1/workbench/runs/${encodeURIComponent(id)}/figures/${a.asset_id}`, sha256: a.sha256, page: a.physical_page, width: a.width_px, height: a.height_px })) })),
      figure_catalog_sha256: source?.catalog_artifact?.sha256 ?? null,
      source_status: issues.length ? issues.some(i => i.includes('missing')) ? 'missing' : 'mismatch' : source ? 'valid' : 'not_parsed', paper: this.summary(paper), pdf_url: `/api/t1/workbench/papers/${paper.id}/pdf`, text_version: source?.document.text_version ?? '' }; }
  async pdf(id: string) { await this.initialize(); return this.readPinned(this.paper(id).pdf); }
  async figure(id: string, assetId: string) { await this.initialize(); this.paper(id);
    const sources = this.runRows().filter(r => r.paper_id === id).map(r => r.source).concat(this.paper(id).latest_source).filter((s): s is SourceSnapshot => Boolean(s));
    const asset = sources.flatMap(s => s.catalog?.figures.flatMap(f => f.regions) ?? []).find(a => a.asset_id === assetId);
    if (!asset) throw new ContractError('workbench_figure_not_found'); return this.readPinned(asset); }
  async runFigure(id: string, assetId: string) { await this.initialize(); const row = this.run(id);
    const asset = row.source?.catalog?.figures.flatMap(f => f.regions).find(a => a.asset_id === assetId);
    if (!asset) throw new ContractError('workbench_figure_not_found'); return this.readPinned(asset); }
  async verifyFigure(id: string, figureId: string, body: WorkbenchFigureCheckInput) {
    await this.initialize(); return this.withRunWrite(id, async () => {
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['expected_catalog_sha256', 'reviewer', 'all_panels_included', 'caption_figure_identity_checked', 'notes'].includes(k))) throw new ContractError('invalid_figure_check');
    this.person(body.reviewer);
    if (body.all_panels_included !== true || body.caption_figure_identity_checked !== true || typeof body.notes !== 'string' || !body.notes.trim() || body.notes.length > 4000) throw new ContractError('explicit_whole_figure_checks_required');
    const row = this.run(id), source = row.source;
    if (!source?.catalog || !source.catalog_artifact) throw new ContractError('figure_catalog_required');
    if (body.expected_catalog_sha256 !== source.catalog_artifact.sha256) throw new WorkflowCatalogConflict(source.catalog_artifact.sha256);
    await this.requireSource(this.paper(row.paper_id), source); await this.readPinned(source.catalog_artifact);
    const figure = source.catalog.figures.find(f => f.figure_id === figureId);
    if (!figure || !figure.regions.length) throw new ContractError('workbench_figure_not_found');
    for (const asset of figure.regions) await this.readPinned(asset);
    const catalog = confirmWholeFigure(source.document, source.catalog, evidenceDigest(source.catalog), figureId, { actor: body.reviewer, checked_at: now(),
      all_panels_included: true, caption_figure_identity_checked: true, notes: body.notes });
    const directory = resolve(this.directory, 'figure-reviews', createHash('sha256').update(id).digest('hex')); await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = resolve(directory, randomUUID() + '.json'), bytes = Buffer.from(JSON.stringify(catalog) + '\n');
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    const next: Artifact = { path: relative(this.codeRoot, path), sha256: digest(bytes) };
    this.store.atomic(() => {
      const current = this.run(id);
      if (current.source?.catalog_artifact?.sha256 !== body.expected_catalog_sha256) throw new WorkflowCatalogConflict(current.source?.catalog_artifact?.sha256 ?? null);
      const previous = current.source.catalog_artifact;
      current.source = { ...current.source, catalog, catalog_artifact: next, figure_history: [...(current.source.figure_history ?? []), previous] };
      this.saveRun(current); this.store.event(id, 'figure_source_check', { figure_id: figureId, reviewer: body.reviewer, previous_catalog_sha256: previous.sha256,
        catalog_sha256: next.sha256, human_record_approval_added: false, explicit_record_figure_review_still_required: true });
    });
    return { verified: true, figure_id: figureId, verification: 'whole_figure_checked', figure_catalog_sha256: next.sha256,
      record_approval_added: false, run_detail: await this.runDetail(id) };
    });
  }
  events(id: string, after = 0): WorkbenchEvent[] {
    if (!this.store.db.prepare('SELECT id FROM workbench_runs WHERE id=?').get(id)) throw new ContractError('workbench_run_not_found');
    return this.store.db.prepare('SELECT payload_json FROM s4_events WHERE run_id=? AND seq>? ORDER BY seq').all(id, after)
      .map(row => JSON.parse(row.payload_json as string) as WorkbenchEvent);
  }
  async start(id: string, scope: Scope, requestId?: string, metadata?: WorkbenchSubmission, modelProfileId?: string, requestedTaskTitle?: unknown, requestedFilename?: unknown) {
    const submission = submissionMetadata(metadata);
    const title = taskTitle(requestedTaskTitle), filename = originalFilename(requestedFilename);
    if (modelProfileId !== undefined && (typeof modelProfileId !== 'string' || !/^model-[a-f0-9]{32}$/u.test(modelProfileId))) throw new ContractError('invalid_model_profile_id');
    await this.initialize();
    this.assertStorageWritable();
    // Replaying a committed request is read-only even after the server restarts,
    // an allowance closes, or a catalogue changes. The original scope is immutable.
    // Keep the exact legacy payload when metadata is absent so old keys still replay after an upgrade.
    return this.submission('start', requestId, { paper_id: id, scope, ...(submission ? { submission } : {}), ...(modelProfileId !== undefined ? { model_profile_id: modelProfileId } : {}), ...(requestedTaskTitle !== undefined ? { task_title: title ?? '' } : {}), ...(requestedFilename !== undefined ? { original_filename: filename } : {}) }, async runId => ({ run: (await this.runs(runId))[0]! }), async remember => this.withBatchAdmission(submission, async () => {
    if (this.shuttingDown) throw new ContractError('server_shutting_down');
    if (submission?.kind === 'batch' && this.store.db.prepare('SELECT batch_id FROM workbench_deleted_batches WHERE batch_id=?').get(submission.batch_id)) throw new ContractError('submission_result_deleted');
    if (this.deletingPapers.has(id)) throw new ContractError('paper_deletion_in_progress');
    // Admission can await source checks or runner preparation before a run exists.
    // Protect that whole interval, including overlapping starts of the same paper.
    this.preparingPapers.set(id, (this.preparingPapers.get(id) ?? 0) + 1);
    try {
    const admittedAt = now();
    assertSchema(ScopeSchema, scope);
    if (scope.features.mode !== 'all' || scope.features.binding_ids.length) throw new ContractError('feature_scope_removed');
    const batch = submission?.kind === 'batch' ? this.runRows().find(row => row.submission?.kind === 'batch' && row.submission.batch_id === submission.batch_id) : undefined;
    const catalog = batch?.scope_catalog ? structuredClone(batch.scope_catalog) : this.currentScopeCatalog();
    if (batch && canonical(scope) !== canonical(this.store.snapshot(batch.id).input.scope)) throw new ContractError('batch_scope_frozen');
    if (batch && (modelProfileId ?? this.modelProfiles?.initial.profile_id) !== batch.model_profile?.profile_id) throw new ContractError('batch_model_frozen');
    if (batch && title !== batch.task_title) throw new ContractError('batch_task_title_frozen');
    if (batch && this.options.catalogProvider && !batch.scope_catalog) throw new ContractError('batch_catalog_snapshot_unavailable');
    const scopeErrors = evidenceScopeIssues(scope, catalog);
    if (scopeErrors.length) throw new ContractError(scopeErrors.join(','));
    const paper = this.paper(id);
    if (submission?.kind === 'batch') {
      const member = this.store.db.prepare(`SELECT w.id FROM workbench_runs w JOIN s4_runs s ON s.id=w.id
        WHERE json_extract(w.payload_json,'$.submission.batch_id')=? AND json_extract(s.input_json,'$.file_sha256')=? ORDER BY w.rowid LIMIT 1`).get(submission.batch_id, paper.pdf.sha256);
      if (member) { this.store.atomic(() => remember(member.id as string)); return { run: (await this.runs(member.id as string))[0]! }; }
    }
    await this.requireSource(paper);
    const runner = this.options.runner; if (!runner) throw new ContractError('server_model_not_enabled');
    if (runner.available?.() === false) throw new ContractError('run_start_allowance_closed');
    if (modelProfileId && !this.modelProfiles) throw new ContractError('model_selection_unavailable');
    const model = this.modelProfiles?.get(modelProfileId ?? this.modelProfiles.initial.profile_id);
    const runId = 'run-' + randomUUID(), directory = resolve(this.directory, 'runs', runId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const input: RunInput = { schema_version: '1', run_id: runId, document_id: id, file_sha256: paper.pdf.sha256, fixture: false, scope: structuredClone(scope),
      rule_version: 'visual-statements-2', runtime_profile: { provider: model?.provider ?? runner.provider, model_id: model?.model_id ?? runner.model_id, endpoint: '', pi_version: '1.4.0', version: 's5-workbench-1' } };
    await runner.prepare?.(input, directory);
    const name = filename ?? paper.filename;
    const row: RunRow = { id: runId, paper_id: id, created_at: admittedAt, origin: runner.controlled ? 'controlled_fixture' : 'workbench_run', controlled: runner.controlled, directory, strategy: 'B0', scope_catalog: catalog, original_filename: name, ...(submission?.kind === 'batch' ? title !== undefined ? { task_title: title } : {} : { task_title: title ?? name }), ...(submission ? { submission } : {}), ...(model ? { model_profile: structuredClone(model) } : {}) };
    this.store.atomic(() => { this.store.create(input, { fixed_method: 'B0', controlled_fixture: runner.controlled }); this.saveRun(row); remember(runId); });
    const controller = new AbortController();
    const promise = this.schedule(runId, controller, () => this.execute(row, input, controller));
    this.active.set(runId, { controller, promise });
    const release = () => { this.active.delete(runId); void this.resumePendingRunCleanup().catch(() => {}); };
    void promise.then(release, release);
    return { run: (await this.runs(runId))[0]! };
    } finally {
      const remaining = this.preparingPapers.get(id)! - 1;
      if (remaining) this.preparingPapers.set(id, remaining); else this.preparingPapers.delete(id);
      void this.resumePendingRunCleanup().catch(() => {});
    }
    }));
  }
  private schedule(id: string, controller: AbortController, run: () => Promise<void>) {
    const promise = new Promise<void>((resolve, reject) => {
      const entry = { id, controller, run, resolve, reject }; this.queue.push(entry);
      controller.signal.addEventListener('abort', () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) { this.queue.splice(index, 1); resolve(); }
      }, { once: true });
    });
    if (this.executing >= this.maxConcurrentRuns) this.store.event(id, 'queue_wait', { max_concurrent_runs: this.maxConcurrentRuns });
    this.drainQueue(); return promise;
  }
  private drainQueue() {
    while (this.executing < this.maxConcurrentRuns && this.queue.length) {
      const entry = this.queue.shift()!;
      if (entry.controller.signal.aborted) { entry.resolve(); continue; }
      this.executing++;
      void entry.run().then(entry.resolve, entry.reject).finally(() => { this.executing--; this.drainQueue(); });
    }
  }
  private async execute(row: RunRow, input: RunInput, controller: AbortController) {
    const signal = controller.signal, executionStarted = Date.now(); let timedOut = false;
    row.execution_started_at = new Date(executionStarted).toISOString(); row.queue_wait_ms = Math.max(0, executionStarted - Date.parse(row.created_at));
    row.runtime_deadline = new Date(executionStarted + (this.options.runTimeoutMs ?? 1800_000)).toISOString();
    const timer = setTimeout(() => {
      if (!terminals.has(this.store.snapshot(row.id).state)) {
        timedOut = true; this.store.transition(row.id, this.store.current(row.id).length ? 'partial' : 'failed');
        this.store.event(row.id, 'run_deadline', { reason: 'document_time_limit', scope: 'execution_slot_including_parse_model_summary', queue_wait_excluded: true, saved_candidates_preserved: true, automatic_resume: false });
        controller.abort();
      }
    }, this.options.runTimeoutMs ?? 1800_000); timer.unref();
    try {
      this.saveRun(row); this.store.event(row.id, 'execution_slot_acquired', { execution_started_at: row.execution_started_at, queue_wait_ms: row.queue_wait_ms, runtime_deadline: row.runtime_deadline, max_concurrent_runs: this.maxConcurrentRuns });
      this.store.transition(row.id, 'parsing'); const paper = this.paper(row.paper_id);
      await this.requireSource(paper);
      const parseStarted = performance.now(); this.store.event(row.id, 'source_parse_started', { actor: 'host', parser: 'configured_local_pdf_parser', total_unknown: true });
      const document = await (this.options.parse ? this.options.parse(input, paper.pdf.path, row.directory, signal) : createConfiguredPdfParserAdapter({ logDirectory: row.directory }).parse({ run_id: row.id, document_id: row.paper_id, file_reference: paper.pdf.path, file_sha256: paper.pdf.sha256, fixture: false }, signal));
      if (signal.aborted) throw new ContractError('run_cancelled'); assertParsedDocument(document);
      this.store.event(row.id, 'source_parse_completed', { actor: 'host', duration_ms: Math.round(performance.now() - parseStarted), physical_pages: document.pages.length,
        source_blocks: document.blocks.length, parser_status: document.parser.status,
        ...('metrics' in document ? { parser_metrics: document.metrics } : {}) });
      if (document.fixture || document.document_id !== row.paper_id || document.file_sha256 !== paper.pdf.sha256 || document.source.file_reference !== paper.pdf.path) throw new ContractError('parsed_source_binding_mismatch');
      await this.requireSource(paper); await assertLivePdfSource(document);
      const irPath = resolve(row.directory, 'document-ir.json'), irBytes = Buffer.from(JSON.stringify(document) + '\n');
      await writeFile(irPath, irBytes, { flag: 'wx', mode: 0o600 });
      const source: SourceSnapshot = { document, ir: { path: relative(this.codeRoot, irPath), sha256: digest(irBytes) } };
      const figuresStarted = performance.now(); this.store.event(row.id, 'figure_discovery_started', { actor: 'host', total_unknown: true });
      try {
        source.catalog = await (this.options.discover ?? discoverPdfFigures)(document, row.directory, signal);
        assertFigureCatalog(document, source.catalog);
        const catalogPath = resolve(row.directory, 'figure-catalog.json'), bytes = Buffer.from(JSON.stringify(source.catalog) + '\n');
        await writeFile(catalogPath, bytes, { flag: 'wx', mode: 0o600 }); source.catalog_artifact = { path: relative(this.codeRoot, catalogPath), sha256: digest(bytes) };
        this.store.event(row.id, 'figure_discovery_completed', { actor: 'host', duration_ms: Math.round(performance.now() - figuresStarted),
          figure_entries: source.catalog.figures.length, available_whole_figures: source.catalog.figures.filter(f => f.verification.status !== 'needs_review' && f.regions.length).length,
          medical_approval: false });
      } catch (error) { if (signal.aborted) throw new ContractError('run_cancelled'); await this.requireSource(paper, source);
        this.store.event(row.id, 'figure_discovery_pending', { text_can_continue: true, error: error instanceof ContractError ? error.code : 'figure_discovery_failed' }); }
      row.source = source; paper.latest_source = source; paper.pages = document.pages.length;
      this.store.atomic(() => { this.saveRun(row); this.savePaper(paper); this.store.event(row.id, 'source_saved', { text_version: document.text_version, physical_pages: document.pages.length, parser_id: document.parser.id, controlled_fixture: row.controlled }); });
      const metadata: EvidenceValidationContext['metadata'] = { task_id: row.id, article_family_id: paper.id, created_at: row.created_at,
        source_version: { file_sha256: paper.pdf.sha256, source_kind: paper.uploaded ? 'user_uploaded_pdf' : 'retained_public_pdf', version: paper.pdf.sha256, obtained_at: row.created_at },
        bibliographic_identity: { title: paper.title, authors: [], venue: null, year: null, doi: null, pmid: null, identity_status: 'user_title_unverified' }, document_access: 'full_text' };
      const result = await this.options.runner!.execute({ input, document, evidence_catalog: structuredClone(row.scope_catalog ?? this.catalog), catalog: source.catalog, directory: row.directory, signal, store: this.store, metadata, execution_started_at: row.execution_started_at, ...(row.model_profile ? { model_profile: structuredClone(row.model_profile) } : {}) });
      this.saveRun({ ...this.run(row.id), coverage: result.coverage, summary: result.summary });
      if (!terminals.has(this.store.snapshot(row.id).state)) throw new ContractError('runner_finished_without_terminal_state');
    } catch (error) {
      const current = this.store.snapshot(row.id).state;
      const code = timedOut ? 'document_time_limit' : error instanceof ContractError ? error.code : 'workflow_execution_failed';
      this.saveRun({ ...this.run(row.id), error: code });
      if (!terminals.has(current)) this.store.transition(row.id, signal.aborted ? this.shuttingDown ? 'interrupted' : 'cancelled' : this.store.current(row.id).length ? 'partial' : 'failed');
      this.store.event(row.id, 'workflow_error', { error: code, saved_candidates_preserved: true, automatic_resume: false, controlled_fixture: row.controlled });
    } finally {
      clearTimeout(timer);
      const saved = { ...this.run(row.id), finished_at: now() }; this.saveRun(saved);
      this.store.event(row.id, 'run_result_saved', { coverage_saved: saved.coverage !== undefined, finalization_complete: true, controlled_fixture: row.controlled });
    }
  }
  async cancel(id: string) { await this.initialize(); this.run(id); const task = this.active.get(id), state = this.store.snapshot(id).state;
    if (!terminals.has(state)) { this.store.transition(id, 'cancelled'); task?.controller.abort(); }
    return { run: (await this.runs(id))[0]! }; }
  private current(id: string, recordId: string, expected?: number): StoredEvidenceVersion {
    this.run(id); const value = this.store.current(id).find(v => v.record.record_id === recordId);
    if (!value || this.annotation(id, value).deleted) throw new ContractError('workbench_record_not_found');
    if (!Number.isSafeInteger(expected) || expected !== value.version) throw new WorkflowConflict(value.version); return value;
  }
  private person(value: unknown): asserts value is string { if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new ContractError('reviewer_required'); }
  private labels(value: WorkbenchLabels | undefined): WorkbenchLabels {
    if (value === undefined) return {}; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError('invalid_record_labels');
    const allowed = new Set(['feature_category', 'evidence_type', 'tags', 'comment', 'evidence_role']);
    if (Object.keys(value).some(k => !allowed.has(k)) || value.feature_category !== undefined && (typeof value.feature_category !== 'string' || !value.feature_category.trim() || value.feature_category.length > 160) ||
      value.comment !== undefined && (typeof value.comment !== 'string' || value.comment.length > 4000) || value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 20 || value.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 80)) ||
      value.evidence_type !== undefined && !['feature_mention', 'definition', 'imaging_observation', 'interpretive_condition', 'association_conclusion'].includes(value.evidence_type) ||
      value.evidence_role !== undefined && !['primary_candidate', 'background_suggestion'].includes(value.evidence_role)) throw new ContractError('invalid_record_labels');
    return structuredClone(value);
  }
  private annotationWrite(id: string, version: EvidenceVersion, annotation: Annotation) { this.store.db.prepare('INSERT INTO workbench_annotations VALUES(?,?,?,?)').run(id, version.record.record_id, version.version, JSON.stringify(annotation)); }
  private assertRevisionInput(body: WorkbenchRevisionInput) {
    if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['expected_version', 'source_unit_ids', 'context_unit_ids', 'labels', 'reviewer', 'reason'].includes(k))) throw new ContractError('source_reselection_only_no_free_text');
    this.person(body.reviewer); if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 4000)) throw new ContractError('invalid_review_reason');
  }
  private selectedFragments(source: SourceSnapshot, ids: string[], allowEmpty: boolean, sourceGlyphPolicyVersion?: string) {
    if (!Array.isArray(ids) || !allowEmpty && !ids.length || ids.length > 64 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new ContractError('invalid_source_unit_selection');
    const units = buildSourceEvidenceUnits(source.document, sourceGlyphPolicyVersion), allowed = new Set(taskSourceBlockIds(source.document, buildArticleScope(source.document), sourceGlyphPolicyVersion));
    const selected = ids.map(id => { const unit = units.find(u => u.unit_id === id); if (!unit || unit.segments.some(s => !allowed.has(s.block_id))) throw new ContractError('source_unit_not_available_for_extraction'); return unit; });
    return selected.flatMap(u => u.segments).sort((a, b) => source.document.blocks.find(x => x.block_id === a.block_id)!.reading_order - source.document.blocks.find(x => x.block_id === b.block_id)!.reading_order || a.start - b.start)
      .filter((s, i, all) => all.findIndex(f => f.block_id === s.block_id && f.start === s.start && f.end === s.end) === i);
  }
  private buildManual(row: RunRow, body: WorkbenchRevisionInput, old?: StoredEvidenceVersion) {
    const source = row.source; if (!source) throw new ContractError('parsed_source_required');
    const input = this.store.snapshot(row.id).input, record = old?.record;
    const sourceGlyphPolicyVersion = record?.extraction_trace.source_glyph_policy_version ?? ((row.coverage as { source_glyph_policy_version?: string } | undefined)?.source_glyph_policy_version === 'agent-assesses-parsed-glyphs-1' ? 'agent-assesses-parsed-glyphs-1' as const : undefined);
    const tableSupportPolicyVersion = record?.extraction_trace.table_support_policy_version;
    const inputOrganizationVersion = record?.extraction_trace.input_organization_version ?? ((row.coverage as { input_organization_version?: string } | undefined)?.input_organization_version === 'source-content-units-2' ? 'source-content-units-2' as const : undefined);
    const main = body.source_unit_ids ? this.selectedFragments(source, body.source_unit_ids, false, sourceGlyphPolicyVersion) : record?.quote_span.segments;
    if (!main?.length) throw new ContractError('source_units_required_for_manual_record');
    const context = body.context_unit_ids ? this.selectedFragments(source, body.context_unit_ids, true, sourceGlyphPolicyVersion) : body.source_unit_ids ? [] : record?.context.fragments ?? [];
    const labels = this.labels(body.labels), raw = (fragments: typeof main) => fragments.map(f => ({ block_id: f.block_id, exact_quote: f.exact_quote, occurrence: f.occurrence }));
    const unknown = { value: null, status: 'unknown' as const, evidence: [] };
    const metadata: EvidenceValidationContext['metadata'] = { task_id: record?.extraction_trace.task_id ?? row.id,
      source_version: record?.source_version ?? { file_sha256: input.file_sha256, source_kind: 'user_uploaded_pdf', version: input.file_sha256, obtained_at: row.created_at },
      article_family_id: record?.article_family_id ?? row.paper_id, bibliographic_identity: record?.bibliographic_identity, document_access: 'full_text', created_at: now() };
    const submission: EvidenceSubmission = { binding: { task_id: metadata.task_id, run_id: row.id, document_id: row.paper_id, file_sha256: input.file_sha256,
      source_version: metadata.source_version.version, text_version: source.document.text_version }, source_fragments: raw(main), context_fragments: raw(context), display_joiner: '\n',
      feature_binding_id: null, feature_name_raw: null, feature_category: labels.feature_category ?? record?.feature_category ?? 'unclassified',
      evidence_type: labels.evidence_type ?? record?.evidence_type ?? 'imaging_observation', disease_or_lesion: unknown, modality: unknown, sequence_or_phase: null,
      assertion: { value: 'unknown', original_wording: '', evidence: [] }, applicability: { status: 'unknown', original_wording: '', evidence: [] }, numeric_expressions: [],
      provenance: { origin: 'unclear', cited_references: [], evidence: [] }, translation_zh: null };
    const blocks = taskSourceBlockIds(source.document, buildArticleScope(source.document), sourceGlyphPolicyVersion);
    const validated = validateEvidenceSubmission(submission, { input, document: source.document, catalog: row.scope_catalog ?? this.catalog, metadata, toolCallId: 'human-' + randomUUID(),
      allowedBlockIds: blocks, readBlockIds: blocks, evidencePolicyVersion: 'visual-statements-2', primaryAssessmentPolicyVersion: 'model-primary-assessment-1',
      sourceGlyphPolicyVersion, tableSupportPolicyVersion, inputOrganizationVersion });
    if (!validated.accepted || !validated.record) throw new ContractError('manual_source_validation_failed:' + validated.issues.map(i => i.code).join(','));
    validated.record.record_id = record?.record_id ?? 'manual-' + randomUUID(); return validated.record;
  }
  async revise(id: string, recordId: string | undefined, body: WorkbenchRevisionInput) {
    await this.initialize(); return this.withRunWrite(id, async () => { this.assertRevisionInput(body); const row = this.run(id), old = recordId ? this.current(id, recordId, body.expected_version) : undefined;
    if (!old && body.expected_version !== undefined) throw new ContractError('manual_add_does_not_take_expected_version');
    if (!row.source) throw new ContractError('parsed_source_required'); await this.requireSource(this.paper(row.paper_id), row.source);
    const labels = this.labels(body.labels), previous = old ? this.annotation(id, old) : { labels: {}, deleted: false, reviewer: '', reason: '' };
    const record = body.source_unit_ids || body.context_unit_ids || !old ? this.buildManual(row, body, old) : structuredClone(old.record);
    if (labels.feature_category) record.feature_category = labels.feature_category; if (labels.evidence_type) record.evidence_type = labels.evidence_type;
    record.review_status = 'pending'; record.review_events = []; record.handoff_status = 'candidate_only';
    this.store.atomic(() => { const value = this.store.humanVersion(id, record, old?.version ?? null, body.reason ?? 'human_revision');
      this.annotationWrite(id, value, { labels: { ...previous.labels, ...labels }, deleted: false, reviewer: body.reviewer, reason: body.reason ?? '' }); });
    return { record: (await this.output(row)).records.find(r => r.id === record.record_id)! };
    });
  }
  async reviewRecord(id: string, recordId: string, body: WorkbenchReviewInput) {
    await this.initialize(); return this.withRunWrite(id, async () => { if (!body || typeof body !== 'object' || Object.keys(body).some(k => !['expected_version', 'action', 'reviewer', 'reason', 'source_text_checked', 'relevance_checked', 'context_checked', 'figure_pairing_checked'].includes(k))) throw new ContractError('invalid_review_input');
    this.person(body.reviewer); if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 4000)) throw new ContractError('invalid_review_reason');
    if (!['approve_text', 'approve_figures', 'reject', 'pending'].includes(body.action)) throw new ContractError('invalid_review_action');
    const row = this.run(id), old = this.current(id, recordId, body.expected_version); if (!row.source) throw new ContractError('parsed_source_required');
    await this.requireSource(this.paper(row.paper_id), row.source);
    const oldReview = this.review(id, old), availableCatalog = await this.availableCatalog(row.source);
    const oldDelivery = allDeliveredRecords(buildEvidenceDelivery(row.source.document, [old], availableCatalog))[0]!;
    if (body.action === 'approve_text' && (body.source_text_checked !== true || body.relevance_checked !== true || body.context_checked !== true)) throw new ContractError('explicit_text_checks_required');
    if (body.action === 'approve_figures' && (oldReview?.decision !== 'approved' || oldReview.text_fingerprint !== oldDelivery.text_fingerprint || body.figure_pairing_checked !== true || oldDelivery.figure_association.status !== 'paired' || !oldDelivery.figure_association.figure_ids.length)) throw new ContractError('current_text_and_explicit_figure_checks_required');
    const record = structuredClone(old.record); record.review_events = []; record.handoff_status = 'candidate_only'; record.review_status = body.action === 'reject' ? 'rejected' : body.action === 'pending' ? 'pending' : 'approved';
    this.store.atomic(() => {
      const value = this.store.humanVersion(id, record, old.version, body.reason ?? body.action), annotation = this.annotation(id, old); this.annotationWrite(id, value, { ...annotation, reviewer: body.reviewer });
      const delivered = allDeliveredRecords(buildEvidenceDelivery(row.source!.document, [value], availableCatalog))[0]!;
      const approved = body.action === 'approve_text' || body.action === 'approve_figures', figures = body.action === 'approve_figures';
      const review: DeliveryReview = { record_id: recordId, record_version: value.version, review_scope: figures ? 'text_and_figures' : 'text_only',
        text_fingerprint: delivered.text_fingerprint, delivery_fingerprint: figures ? delivered.delivery_fingerprint : null, decision: approved ? 'approved' : body.action === 'reject' ? 'rejected' : 'needs_context',
        actor: body.reviewer, reviewed_at: now(), source_text_checked: approved, relevance_checked: approved, context_checked: approved, figure_pairing_checked: figures, reason: body.reason ?? '' };
      this.store.db.prepare('INSERT INTO workbench_reviews VALUES(?,?,?,?)').run(id, recordId, value.version, JSON.stringify(review));
      // Old clients may still submit a genuine review after using the new filter.
      // Its explicit reject/pending/approve must not disappear behind an older choice.
      if (this.store.db.prepare('SELECT record_id FROM workbench_retentions WHERE run_id=? AND record_id=?').get(id, recordId)) {
        const previous = this.retention(id, old), selection: WorkbenchRetention = { status: body.action === 'reject' ? 'excluded' : 'kept',
          revision: previous.revision + 1, origin: 'legacy_review', record_version: value.version, updated_at: review.reviewed_at };
        this.store.db.prepare('UPDATE workbench_retentions SET payload_json=? WHERE run_id=? AND record_id=?').run(JSON.stringify(selection), id, recordId);
      }
      this.store.event(id, 'human_review', { record_id: recordId, record_version: value.version, action: body.action, reviewer: body.reviewer, text_approved: approved, figures_approved: figures });
    });
    return { record: (await this.output(row)).records.find(r => r.id === recordId)! };
    });
  }
  async retainRecord(id: string, recordId: string, body: WorkbenchRetentionInput) {
    await this.initialize(); return this.withRunWrite(id, async () => {
    if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['expected_version', 'expected_retention_revision', 'status'].includes(key)) ||
      !['kept', 'excluded'].includes(body.status) || !Number.isSafeInteger(body.expected_retention_revision) || body.expected_retention_revision < 0) throw new ContractError('invalid_retention_input');
    this.store.atomic(() => {
      const version = this.current(id, recordId, body.expected_version), previous = this.retention(id, version);
      if (previous.revision !== body.expected_retention_revision) throw new WorkflowRetentionConflict(version.version, previous.revision);
      const retention: WorkbenchRetention = { status: body.status, revision: previous.revision + 1, origin: 'user', record_version: version.version, updated_at: now() };
      this.store.db.prepare('INSERT INTO workbench_retentions VALUES(?,?,?) ON CONFLICT(run_id,record_id) DO UPDATE SET payload_json=excluded.payload_json').run(id, recordId, JSON.stringify(retention));
      this.store.event(id, 'retention_changed', { record_id: recordId, record_version: version.version, previous_status: previous.status,
        status: retention.status, retention_revision: retention.revision, medical_approval_added: false });
    });
    return { record: (await this.output(this.run(id))).records.find(record => record.id === recordId)! };
    });
  }
  async deleteRecord(id: string, recordId: string, body: WorkbenchRevisionInput) {
    await this.initialize(); return this.withRunWrite(id, async () => { this.assertRevisionInput(body); const old = this.current(id, recordId, body.expected_version), record = structuredClone(old.record);
    record.review_status = 'rejected'; record.review_events = []; record.handoff_status = 'candidate_only';
    this.store.atomic(() => { const next = this.store.humanVersion(id, record, old.version, body.reason ?? 'human_delete');
      this.annotationWrite(id, next, { ...this.annotation(id, old), deleted: true, reviewer: body.reviewer, reason: body.reason ?? '' }); });
    return { deleted: true, record_id: recordId };
    });
  }
  async export(id: string, kind: WorkbenchExportKind) {
    await this.initialize(); return this.withRunWrite(id, async () => { if (!['candidate_jsonl', 'candidate_csv', 'approved_jsonl', 'approved_csv', 'candidate_package', 'approved_package', 'retained_jsonl', 'retained_csv', 'retained_package'].includes(kind)) throw new ContractError('export_kind_not_found');
    // Engine terminal state precedes its last file/coverage writes. A terminal download
    // waits for that coordinator promise instead of exporting a transient null coverage.
    const finalizing = this.active.get(id); if (finalizing && terminals.has(this.store.snapshot(id).state)) await finalizing.promise;
    const row = this.run(id); if (!row.source) throw new ContractError('parsed_source_required');
    const source = row.source, approved = kind.startsWith('approved'), retained = kind.startsWith('retained'), catalog = await this.availableCatalog(source), paper = this.paper(row.paper_id);
    if (approved || retained) await this.requireSource(paper, source);
    const versions = this.visibleVersions(id), reviews: DeliveryReview[] = [];
    const retentionSnapshot = retained ? { schema_version: 'workbench-retention-snapshot-1', selected_at: now(),
      run_event_seq: Number(this.store.db.prepare('SELECT COALESCE(MAX(seq),0) seq FROM s4_events WHERE run_id=?').get(id)!.seq),
      records: versions.map(version => { const selection = this.retention(id, version); return { record_id: version.record.record_id,
        record_version: version.version, status: selection.status, revision: selection.revision, origin: selection.origin, decision_record_version: selection.record_version }; }) } : undefined;
    const currentDelivery = approved ? allDeliveredRecords(buildEvidenceDelivery(source.document, versions, catalog)) : [];
    const selected = retained ? versions.filter(version => retentionSnapshot!.records.find(record => record.record_id === version.record.record_id)!.status === 'kept') : approved ? versions.filter(v => { const review = this.review(id, v), delivered = currentDelivery.find(r => r.record_id === v.record.record_id);
      if (review?.decision !== 'approved' || !delivered || review.text_fingerprint !== delivered.text_fingerprint) return false;
      // A missing/changed image invalidates the image confirmation; the unchanged text confirmation remains usable.
      reviews.push(review.review_scope === 'text_and_figures' && review.delivery_fingerprint !== delivered.delivery_fingerprint ? {
        ...review, review_scope: 'text_only', delivery_fingerprint: null, figure_pairing_checked: false,
        reason: review.reason + '\nFigure assets/pairing changed or became unavailable; prior text confirmation only.' } : review); return true; }) : versions;
    if (approved && !selected.length) throw new ContractError('no_current_approved_records');
    if (retained && !selected.length) throw new ContractError('no_retained_records');
    const exportId = 'export-' + randomUUID(), parent = resolve(this.directory, 'exports'); await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = resolve(parent, exportId);
    // Historical candidate inspection remains possible without a live PDF. Candidate packages retain the same source guard as the core exporter.
    const issues = await this.sourceIssues(paper, source);
    if (issues.length && !approved && !retained && !kind.endsWith('package')) {
      const output = await this.output(row), text = kind.endsWith('jsonl') ? output.records.map(r => JSON.stringify({ ...r, historical_source_issues: issues })).join('\n') + '\n' : this.recordCsv(output.records);
      this.store.event(id, 'historical_candidate_export', { export_id: exportId, source_issues: issues, approved: false });
      return { bytes: Buffer.from(text), filename: id + '-' + kind + (kind.endsWith('jsonl') ? '.jsonl' : '.csv'), type: kind.endsWith('jsonl') ? 'application/x-ndjson' : 'text/csv; charset=utf-8' };
    }
    const humanRoles = selected.flatMap(v => { const annotation = this.annotation(id, v); return annotation.labels.evidence_role ? [{ record_id: v.record.record_id,
      record_version: v.version, role: annotation.labels.evidence_role, actor: annotation.reviewer }] : []; });
    await exportEvidenceDelivery(source.document, selected, { codeRoot: this.codeRoot, directory, catalog, mode: approved ? 'approved' : retained ? 'retained' : 'candidates', reviews, humanRoles,
      ...(retained ? { retentionSelections: retentionSnapshot!.records.filter((record): record is typeof record & { status: 'kept' } => record.status === 'kept') } : {}),
      coverage: { ...(typeof row.coverage === 'object' && row.coverage ? row.coverage : {}), run_id: id, state: this.store.snapshot(id).state,
        controlled_fixture: row.controlled, result_ready: Boolean(row.finished_at) || !this.active.has(id), medical_quality_approved: false, automatic_resume: false } });
    const annotations = selected.map(v => ({ record_id: v.record.record_id, record_version: v.version, ...this.annotation(id, v) }));
    await writeFile(resolve(directory, 'human-annotations.json'), JSON.stringify(annotations, null, 2) + '\n');
    await writeFile(resolve(directory, 'source-record-versions.jsonl'), selected.map(v => JSON.stringify(v)).join('\n') + (selected.length ? '\n' : ''));
    if (retentionSnapshot) await writeFile(resolve(directory, 'retention.json'), JSON.stringify(retentionSnapshot, null, 2) + '\n');
    const manifestPath = resolve(directory, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    Object.assign(manifest, { controlled_fixture: row.controlled, origin: row.origin, run_id: id, source_ir_sha256: source.ir.sha256, figure_catalog_sha256: source.catalog_artifact?.sha256 ?? null,
      ...(row.scope_catalog ? { scope_catalog: row.scope_catalog, scope: this.store.snapshot(id).input.scope } : {}),
      original_28_field_records: 'source-record-versions.jsonl; human-annotations.json is separate from paper text' });
    if (retentionSnapshot) Object.assign(manifest, { retention_snapshot: 'retention.json', selection_at: retentionSnapshot.selected_at,
      selection_run_event_seq: retentionSnapshot.run_event_seq, current_record_count: versions.length,
      excluded_record_count: versions.length - selected.length });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    this.store.atomic(() => { this.store.db.prepare('INSERT INTO workbench_exports VALUES(?,?,?)').run(exportId, id, JSON.stringify({ kind, created_at: now(), versions: selected.map(v => [v.record.record_id, v.version]), directory: relative(this.codeRoot, directory) }));
      this.store.event(id, 'export_saved', { export_id: exportId, kind, record_count: selected.length, controlled_fixture: row.controlled }); });
    if (kind.endsWith('package')) {
      const archive = directory + '.tar.gz';
      await new Promise<void>((accept, reject) => { const child = spawn('tar', ['-czf', archive, '-C', directory, '.'], { stdio: 'ignore' }); child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new ContractError('archive_failed'))); });
      return { bytes: await readFile(archive), filename: id + '-' + kind + '.tar.gz', type: 'application/gzip', record_count: selected.length };
    }
    // Keep primary/background records together in single-file downloads; packages keep the established separate files too.
    const delivery = JSON.parse(await readFile(resolve(directory, 'delivery.json'), 'utf8')), records = [...delivery.records, ...(delivery.background_records ?? [])];
    if (kind.endsWith('jsonl')) return { bytes: Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')), filename: id + '-' + kind + '.jsonl', type: 'application/x-ndjson', record_count: selected.length };
    const csvs = await Promise.all(['records.csv', 'background-records.csv'].map(f => readFile(resolve(directory, f), 'utf8').catch(() => '')));
    return { bytes: Buffer.from(csvs[0]! + (csvs[1] ? csvs[1].split('\n').slice(1).join('\n') : '')), filename: id + '-' + kind + '.csv', type: 'text/csv; charset=utf-8', record_count: selected.length };
    });
  }
  private recordCsv(records: WorkbenchRecord[]) { const quote = (s: string) => '"' + s.replace(/"/g, '""') + '"';
    return '\ufeffrecord_id,record_version,fragment_index,original_fragment,physical_page,block_id,start,end,figure_status\n' + records.flatMap(r => r.fragments.map((f, i) => [r.id, String(r.version), String(i), f.exact_quote, String(f.physical_page), f.block_id, String(f.start), String(f.end), r.association].map(quote).join(','))).join('\n') + '\n'; }
  private batchRows(id: string) {
    submissionMetadata({ kind: 'batch', batch_id: id });
    return this.runRows().filter(row => row.submission?.kind === 'batch' && row.submission.batch_id === id);
  }
  async cancelBatch(id: string) {
    await this.initialize();
    return this.withBatchAdmission({ kind: 'batch', batch_id: id }, async () => {
      const rows = this.batchRows(id); if (!rows.length) throw new ContractError('workbench_batch_not_found');
      for (const row of rows) if (this.active.has(row.id) || !terminals.has(this.store.snapshot(row.id).state)) await this.cancel(row.id);
      return { runs: (await this.runs()).filter(run => run.submission?.kind === 'batch' && run.submission.batch_id === id) };
    });
  }
  /** One archive, with separate unchanged per-run packages and an explicit source manifest. */
  async exportBatch(id: string) {
    await this.initialize();
    return this.withBatchAdmission({ kind: 'batch', batch_id: id }, async () => {
      const rows = this.batchRows(id); if (!rows.length) throw new ContractError('workbench_batch_not_found');
      const lock = async <T>(index: number, operation: () => Promise<T>): Promise<T> => index === rows.length ? operation() : this.withRunWrite(rows[index]!.id, () => lock(index + 1, operation));
      return lock(0, async () => {
        await mkdir(resolve(this.directory, 'exports'), { recursive: true });
        const directory = await mkdtemp(resolve(this.directory, 'exports', 'batch-')), archive = directory + '.tar.gz';
        try {
          const members: Array<{ run_id: string; document_id: string; original_filename: string; package: string | null; kept_count: number; empty_reason?: 'no_retained_records' }> = [];
          for (const row of rows) {
            const name = row.id + '.tar.gz'; let count = 0;
            try {
              const output = await this.export(row.id, 'retained_package'); count = output.record_count ?? 0;
              await writeFile(resolve(directory, name), output.bytes);
            } catch (error) {
              if (!(error instanceof ContractError && error.code === 'no_retained_records')) throw new ContractError(`batch_export_member_blocked:${row.id}:${row.original_filename ?? row.paper_id}:${error instanceof ContractError ? error.code : 'request_failed'}`);
            }
            members.push({ run_id: row.id, document_id: row.paper_id, original_filename: row.original_filename ?? this.paper(row.paper_id).filename, package: count ? name : null, kept_count: count,
              ...(!count ? { empty_reason: 'no_retained_records' as const } : {}) });
          }
          if (!members.some(member => member.kept_count)) throw new ContractError('no_retained_records');
          await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ schema_version: 't1-batch-export-1', batch_id: id, task_title: rows[0]!.task_title ?? null,
            selection: 'all_members_retained_results', source_isolation: 'each_member_owns_its_original_pages_figures_and_versions', members, medical_quality_approved: false }, null, 2) + '\n');
          await new Promise<void>((accept, reject) => { const child = spawn('tar', ['-czf', archive, '-C', directory, '.'], { stdio: 'ignore' }); child.on('error', reject); child.on('close', code => code === 0 ? accept() : reject(new ContractError('archive_failed'))); });
          return { bytes: await readFile(archive), filename: 'batch-' + id + '-retained.tar.gz', type: 'application/gzip' };
        } finally { await rm(directory, { recursive: true, force: true }); await rm(archive, { force: true }); }
      });
    });
  }
  private cleanupPlan(source: RunRow): RunCleanupPlan {
    const exports = this.store.db.prepare('SELECT payload_json FROM workbench_exports WHERE run_id=?').all(source.id)
      .map(value => (JSON.parse(value.payload_json as string) as { directory?: string }).directory).filter((path): path is string => Boolean(path));
    return { status: 'cleanup_pending', targets: [
      ...(source.directory ? [{ path: source.directory, parent: 'runs' as const }] : []),
      ...[source.source?.catalog_artifact, ...(source.source?.figure_history ?? [])].filter((artifact): artifact is Artifact => Boolean(artifact)).map(artifact => ({ path: artifact.path, parent: 'figure-reviews' as const })),
      ...exports.flatMap(path => [{ path, parent: 'exports' as const }, { path: path + '.tar.gz', parent: 'exports' as const }]),
    ] };
  }
  private paperHasWork(paperId: string) {
    return this.preparingPapers.has(paperId) || this.runRows().some(row => row.paper_id === paperId
      && (this.active.has(row.id) || this.runWrites.has(row.id) || !terminals.has(this.store.snapshot(row.id).state)));
  }
  private assertRunCanBeDeleted(row: RunRow) {
    if (this.active.has(row.id) || this.runWrites.has(row.id) || !terminals.has(this.store.snapshot(row.id).state)) throw new ContractError('paper_busy_before_deleting_run');
  }
  private async withDirectRunCleanup<T>(operation: () => Promise<T>): Promise<T> {
    this.directCleanupCount++;
    try { return await operation(); }
    finally {
      this.directCleanupCount--;
      if (!this.directCleanupCount && this.cleanupRetryRequested) void this.resumePendingRunCleanup().catch(() => {});
    }
  }
  /** Logical deletion is run-owned; shared file cleanup waits for the paper's
   * preparation, coordinator and human-write guards to become idle. */
  private async tryRunCleanup(id: string, paperId: string, plan: RunCleanupPlan) {
    if (this.deletingPapers.has(paperId) || this.paperHasWork(paperId)) return undefined;
    this.deletingPapers.add(paperId);
    let completed = false;
    try { const result = await this.finishRunCleanup(id, paperId, plan); completed = true; return result; }
    finally {
      this.deletingPapers.delete(paperId);
      // A concurrent scan may have skipped another plan behind this lock.
      // Successful cleanup is a new safe point; failures must not self-retry.
      if (completed) void this.resumePendingRunCleanup().catch(() => {});
    }
  }
  /** Coalesce safe-point notifications. Never wait for active work inside this
   * scan: its caller may be the coordinator that just released that work. */
  private resumePendingRunCleanup(): Promise<void> {
    this.cleanupRetryRequested = true;
    if (this.storageCleanup) return Promise.resolve();
    if (this.cleanupFlight) return this.cleanupFlight;
    if (this.directCleanupCount) return Promise.resolve();
    this.cleanupFlight = Promise.resolve().then(async () => {
      do {
        this.cleanupRetryRequested = false;
        for (const tombstone of this.store.db.prepare('SELECT run_id,paper_id,payload_json FROM workbench_deleted_runs').all()) {
          if (this.directCleanupCount) { this.cleanupRetryRequested = true; break; }
          const plan = JSON.parse(tombstone.payload_json as string) as RunCleanupPlan;
          if (plan.status !== 'cleanup_pending') continue;
          try { await this.tryRunCleanup(tombstone.run_id as string, tombstone.paper_id as string, plan); }
          catch { /* Keep the durable plan for DELETE retry or restart recovery. */ }
        }
      } while (this.cleanupRetryRequested && !this.directCleanupCount);
    }).finally(() => {
      this.cleanupFlight = undefined;
      // Guard releases can arrive after the last loop check, before finally.
      // Preserve that notification while keeping failures dormant.
      if (this.cleanupRetryRequested && !this.directCleanupCount) return this.resumePendingRunCleanup();
    });
    return this.cleanupFlight;
  }
  /** Validate every source before deleting any member, then tombstone the entire task atomically. */
  async deleteBatch(id: string) {
    await this.initialize();
    return this.withStorageMutation(() => this.performDeleteBatch(id));
  }
  private async performDeleteBatch(id: string) {
    return this.withBatchAdmission({ kind: 'batch', batch_id: id }, () => this.withDirectRunCleanup(async () => {
      const rows = this.batchRows(id), saved = this.store.db.prepare('SELECT payload_json FROM workbench_deleted_batches WHERE batch_id=?').get(id);
      const deletion: BatchDeletion = saved ? JSON.parse(saved.payload_json as string) : { members: rows.map(row => ({ run_id: row.id, paper_id: row.paper_id })) };
      if (!deletion.members.length) throw new ContractError('workbench_batch_not_found');
      const paperIds = new Set(deletion.members.map(member => member.paper_id));
      for (const paperId of paperIds) if (this.deletingPapers.has(paperId) && !saved) throw new ContractError('paper_deletion_in_progress');
      for (const row of rows) this.assertRunCanBeDeleted(row);
      if (!saved) {
        const plans = rows.map(row => ({ row, plan: { ...this.cleanupPlan(row), batch_id: id } }));
        this.store.atomic(() => {
          this.store.db.prepare('INSERT INTO workbench_deleted_batches VALUES(?,?)').run(id, JSON.stringify(deletion));
          for (const { row, plan } of plans) {
            this.deleteRunRows(row.id);
            this.store.db.prepare('INSERT INTO workbench_deleted_runs VALUES(?,?,?,?)').run(row.id, row.paper_id, now(), JSON.stringify(plan));
          }
        });
        for (const { row } of plans) { this.outputCache.delete(row.id); this.progressEventsCache.delete(row.id); }
      }
      let pending = false, deferred = false;
      for (const member of deletion.members) {
        const tombstone = this.store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(member.run_id);
        const plan = tombstone ? JSON.parse(tombstone.payload_json as string) as RunCleanupPlan : undefined;
        if (plan?.status === 'cleanup_pending') try { if (!await this.tryRunCleanup(member.run_id, member.paper_id, plan)) deferred = true; } catch { pending = true; }
      }
      const runIds = deletion.members.map(member => member.run_id);
      if (pending) throw new WorkflowBatchCleanupPending(id, runIds);
      return { deleted: true, batch_id: id, run_ids: runIds, already_deleted: Boolean(saved), cleanup_deferred: deferred, scope: 'whole_batch_task_results_versions_reviews_retention_events_exports' };
    }));
  }
  async deleteTaskRun(id: string) {
    await this.initialize();
    const existing = this.store.db.prepare('SELECT payload_json FROM workbench_runs WHERE id=?').get(id);
    const row = existing ? JSON.parse(existing.payload_json as string) as RunRow : undefined;
    const deleted = !row ? this.store.db.prepare('SELECT payload_json FROM workbench_deleted_runs WHERE run_id=?').get(id) : undefined;
    const batch = row?.submission?.kind === 'batch' ? row.submission.batch_id : deleted ? (JSON.parse(deleted.payload_json as string) as RunCleanupPlan).batch_id : undefined;
    if (batch) throw new ContractError('batch_task_deletion_required');
    return this.deleteRun(id);
  }
  private deleteRunRows(id: string) {
    for (const table of ['workbench_annotations', 'workbench_reviews', 'workbench_retentions', 'workbench_exports', 's4_batches', 's4_versions', 's4_events']) this.store.db.prepare(`DELETE FROM ${table} WHERE run_id=?`).run(id);
    this.store.db.prepare('DELETE FROM workbench_runs WHERE id=?').run(id); this.store.db.prepare('DELETE FROM s4_runs WHERE id=?').run(id);
  }
  private async existingPath(path: string) {
    try { return await realpath(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private async referencedSourcePaths() {
    const paths = new Set<string>();
    const collect = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' && ['path', 'file_reference'].includes(key)) paths.add(resolve(this.codeRoot, item));
        else if (item && typeof item === 'object') collect(item);
      }
    };
    for (const row of this.store.db.prepare('SELECT payload_json FROM workbench_papers').all()) collect(JSON.parse(row.payload_json as string));
    for (const row of this.runRows()) { collect(row.source); if (row.directory) paths.add(resolve(row.directory)); }
    for (const row of this.store.db.prepare('SELECT payload_json FROM workbench_exports').all()) {
      const directory = (JSON.parse(row.payload_json as string) as { directory?: string }).directory;
      if (directory) { paths.add(resolve(this.codeRoot, directory)); paths.add(resolve(this.codeRoot, directory) + '.tar.gz'); }
    }
    for (const path of [...paths]) { const pinned = await this.existingPath(path); if (pinned) paths.add(pinned); }
    return paths;
  }
  /** Never follow retained evidence paths into deletion; only owned runtime roots qualify. */
  private async cleanOwnedArtifacts(path: string, parent: string, references: ReadonlySet<string>): Promise<{ removed: number; retained: number }> {
    const target = resolve(this.codeRoot, path), rel = relative(parent, target), empty = { removed: 0, retained: 0 };
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return empty;
    const [root, pinned] = await Promise.all([this.existingPath(parent), this.existingPath(target)]);
    if (!root || !pinned) return empty;
    const pinnedRel = relative(root, pinned); if (!pinnedRel || pinnedRel.startsWith('..') || isAbsolute(pinnedRel)) return empty;
    const inside = (directory: string, entry: string) => { const rest = relative(directory, entry); return rest !== '' && !rest.startsWith('..') && !isAbsolute(rest); };
    const walk = async (entry: string): Promise<{ removed: number; retained: number }> => {
      if (references.has(entry)) return { removed: 0, retained: 1 };
      if (![...references].some(reference => inside(entry, reference))) { await rm(entry, { recursive: true, force: true }); return { removed: 1, retained: 0 }; }
      const result = { removed: 0, retained: 0 };
      for (const child of await readdir(entry, { withFileTypes: true })) {
        const childPath = resolve(entry, child.name);
        if (child.isSymbolicLink()) {
          if (references.has(childPath)) result.retained++; else { await rm(childPath, { force: true }); result.removed++; }
        } else { const cleaned = await walk(childPath); result.removed += cleaned.removed; result.retained += cleaned.retained; }
      }
      return result;
    };
    return walk(pinned);
  }
  private async finishRunCleanup(id: string, paperId: string, plan: RunCleanupPlan) {
    const result = { removed: 0, retained: 0 };
    try {
      for (const target of plan.targets) {
        const references = await this.referencedSourcePaths();
        const current = await this.cleanOwnedArtifacts(target.path, resolve(this.directory, target.parent), references);
        result.removed += current.removed; result.retained += current.retained;
      }
      this.store.db.prepare('UPDATE workbench_deleted_runs SET payload_json=? WHERE run_id=?').run(JSON.stringify({ ...plan, status: 'complete' }), id);
      this.outputCache.delete(id);
      this.progressEventsCache.delete(id);
      return { deleted: true, run_id: id, paper_id: paperId, already_deleted: false, shared_source_artifacts_retained: result.retained, scope: 'single_run_results_versions_reviews_retention_events_exports' };
    } catch { throw new WorkflowRunCleanupPending(id, paperId); }
  }
  async deleteRun(id: string) {
    await this.initialize();
    return this.withStorageMutation(() => this.performDeleteRun(id));
  }
  private async performDeleteRun(id: string) {
    const tombstone = this.store.db.prepare('SELECT paper_id,payload_json FROM workbench_deleted_runs WHERE run_id=?').get(id);
    const savedPlan = tombstone ? JSON.parse(tombstone.payload_json as string) as RunCleanupPlan : undefined;
    if (tombstone && savedPlan?.status === 'complete') return { deleted: true, run_id: id, paper_id: tombstone.paper_id as string, already_deleted: true };
    const row = tombstone ? undefined : this.run(id), paperId = row?.paper_id ?? tombstone!.paper_id as string;
    if (this.deletingPapers.has(paperId) && !tombstone) throw new ContractError('paper_deletion_in_progress');
    if (row) this.assertRunCanBeDeleted(row);
    const plan = savedPlan ?? this.cleanupPlan(row!);
    if (!savedPlan) {
      this.store.atomic(() => {
        this.deleteRunRows(id);
        this.store.db.prepare('INSERT INTO workbench_deleted_runs VALUES(?,?,?,?)').run(id, paperId, now(), JSON.stringify(plan));
      });
      this.outputCache.delete(id); this.progressEventsCache.delete(id);
    }
    return this.withDirectRunCleanup(async () => await this.tryRunCleanup(id, paperId, plan) ?? { deleted: true, run_id: id, paper_id: paperId, already_deleted: Boolean(savedPlan), cleanup_deferred: true,
      scope: 'single_run_results_versions_reviews_retention_events_exports' });
  }
  async deletePaper(id: string) {
    await this.initialize();
    return this.withStorageMutation(() => this.performDeletePaper(id));
  }
  private async performDeletePaper(id: string) {
    if (this.deletingPapers.has(id)) throw new ContractError('paper_deletion_in_progress');
    const paper = this.paper(id), runs = this.runRows().filter(r => r.paper_id === id);
    if (this.preparingPapers.has(id) || runs.some(r => this.active.has(r.id) || this.runWrites.has(r.id) || !terminals.has(this.store.snapshot(r.id).state))) throw new ContractError('cancel_active_runs_before_deleting_paper');
    this.deletingPapers.add(id);
    try {
    return await this.withPdfArtifact(paper.pdf, async () => {
    const exportDirectories = runs.flatMap(row => this.store.db.prepare('SELECT payload_json FROM workbench_exports WHERE run_id=?').all(row.id)
      .map(value => (JSON.parse(value.payload_json as string) as { directory?: string }).directory).filter((d): d is string => Boolean(d)));
    this.store.atomic(() => {
      for (const row of runs) {
        this.deleteRunRows(row.id);
      }
      this.store.db.prepare('DELETE FROM workbench_papers WHERE id=?').run(id);
      this.store.db.prepare('INSERT INTO workbench_deleted_sources VALUES(?,?) ON CONFLICT(paper_id) DO NOTHING').run(id, now());
    });
    let pdfReferenced = false;
    // Immutable retained evidence is never deleted. Uploaded content-addressed PDFs are removed only after their last reference.
    {
      // An upload may have committed while this deletion waited for the PDF queue.
      // Decide from live references under that same queue, never an earlier snapshot.
      const references = await this.referencedSourcePaths(), target = resolve(this.codeRoot, paper.pdf.path), pinned = await this.existingPath(target);
      pdfReferenced = references.has(target) || Boolean(pinned && references.has(pinned));
      if (paper.uploaded && !pdfReferenced) await rm(resolve(this.codeRoot, paper.pdf.path), { force: true });
    }
    const otherPapers = this.store.db.prepare('SELECT payload_json FROM workbench_papers').all().map(r => JSON.parse(r.payload_json as string) as PaperRow);
    const stillReferenced = JSON.stringify({ papers: otherPapers, runs: this.runRows() });
    for (const row of runs) if (row.directory && !stillReferenced.includes(row.directory) && !stillReferenced.includes(relative(this.codeRoot, row.directory))) await rm(row.directory, { recursive: true, force: true });
    for (const artifact of runs.flatMap(row => [row.source?.catalog_artifact, ...(row.source?.figure_history ?? [])]).filter((a): a is Artifact => Boolean(a))) {
      const path = resolve(this.codeRoot, artifact.path), rel = relative(resolve(this.directory, 'figure-reviews'), path);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel) && !stillReferenced.includes(artifact.path)) await rm(path, { force: true });
    }
    for (const path of exportDirectories) { const target = resolve(this.codeRoot, path), rel = relative(resolve(this.directory, 'exports'), target);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) { await rm(target, { recursive: true, force: true }); await rm(target + '.tar.gz', { force: true }); } }
    for (const row of runs) { this.outputCache.delete(row.id); this.progressEventsCache.delete(row.id); }
    for (const key of this.sourceUnitCache.keys()) if (key.startsWith(id + ':')) this.sourceUnitCache.delete(key);
    return { deleted: true, paper_id: id, runs_deleted: runs.length, shared_pdf_retained: pdfReferenced, scope: 'paper_runs_candidates_reviews_and_unshared_uploaded_files' };
    });
    } finally { this.deletingPapers.delete(id); void this.resumePendingRunCleanup().catch(() => {}); }
  }
  async waitForIdle() { await Promise.all([...this.active.values()].map(t => t.promise)); await this.resumePendingRunCleanup(); }
  async close() {
    this.shuttingDown = true;
    for (const [id, task] of this.active) { if (!terminals.has(this.store.snapshot(id).state)) this.store.transition(id, 'interrupted'); task.controller.abort(); }
    await this.waitForIdle();
  }
}
