/** T1 web views. No provider credentials or filesystem paths cross this contract. */
export const TASK_COMPLETION_RULE_VERSION = 'task-flow-completion-2';
export interface WorkbenchTaskCompletion {
  rule_version: string; rule_origin: 'persisted' | 'legacy_evidence_projection'; processing_complete: boolean;
  source_gap_blocks: number; original_task_processing_complete?: boolean; original_rule_version?: string;
}
export interface WorkbenchSourceGap {
  block_id: string; physical_page: number; text_version: string; original_text: string;
  uncertain_spans: Array<{ start: number; end: number; code: string }>;
}
export interface WorkbenchFragment {
  block_id: string; text_version: string; start: number; end: number; exact_quote: string;
  occurrence: number; physical_page: number; bbox: number[]; location_precision: string;
}
/** Read-only layout over the original fragments. Indices are zero based; quotes and offsets are never rewritten. */
export interface WorkbenchReadingPassage {
  fragment_indices: number[];
  joins: Array<{ before_fragment: number; kind: 'offset_contiguous' | 'source_whitespace' | 'line_wrap' | 'checked_continuation'; source_whitespace?: string }>;
}
export interface WorkbenchRetention {
  status: 'kept' | 'excluded'; revision: number;
  origin: 'default' | 'user' | 'legacy_review';
  record_version: number; updated_at?: string;
}
export interface WorkbenchRetentionInput {
  expected_version: number; expected_retention_revision: number; status: 'kept' | 'excluded';
}
export interface WorkbenchAsset { id: string; url: string; sha256: string; page: number; width: number; height: number }
export interface WorkbenchFigure {
  id: string; number: string | null; verification: string; caption: WorkbenchFragment[];
  caption_passages?: WorkbenchReadingPassage[];
  assets: WorkbenchAsset[]; human_approved: false;
}
export interface WorkbenchRecord {
  id: string; version: number; run_id: string; fragments: WorkbenchFragment[]; context: WorkbenchFragment[];
  passages?: WorkbenchReadingPassage[]; context_passages?: WorkbenchReadingPassage[]; retention?: WorkbenchRetention;
  association: 'paired' | 'pending' | 'no_explicit_reference' | 'not_checked'; figure_ids: string[];
  proposed_figure_ids: string[]; reasons: string[];
  review_status: string; text_fingerprint: string; delivery_fingerprint: string;
  evidence_role?: 'primary_candidate' | 'background_suggestion';
  model_primary_assessment?: import('./extraction-evidence.js').PrimaryAssessment | null;
  actor?: 'automatic' | 'human'; deleted?: boolean; labels?: WorkbenchLabels;
  text_approved?: boolean; figures_approved?: boolean; review_reason?: string;
  source_unit_ids?: string[]; context_unit_ids?: string[];
  supporting_table_evidence?: NonNullable<import('./extraction-evidence.js').EvidenceRecord['context']['supporting_table_evidence']>;
}
export interface WorkbenchOutput {
  id: string; strategy: string; state: string; origin: 'historical_compatibility_replay' | 'workbench_run' | 'controlled_fixture';
  records: WorkbenchRecord[]; full_recall_claimed: false; medical_quality_approved: false;
  fixture?: boolean; coverage?: unknown; error?: string; scope?: import('./index.js').Scope;
  scope_catalog?: import('./extraction-evidence.js').EvidenceCatalog;
  result_ready?: boolean;
  task_completion?: WorkbenchTaskCompletion;
  source_gaps?: WorkbenchSourceGap[];
  summary?: string; summary_is_diagnostic?: true;
  same_source_review_index?: WorkbenchSameSourceReviewIndex;
}
export interface WorkbenchPaper {
  id: string; title: string; language: string; pages: number; note: string; sha256: string;
  output_ids: string[];
  uploaded?: boolean; filename?: string;
}
export interface WorkbenchUpload { paper: WorkbenchPaper; reused: boolean }
/** File sizes within the managed application roots; disk capacity is separate. No filesystem paths are exposed. */
export type WorkbenchStorageCategory = 'pdf' | 'parse' | 'figures' | 'exports' | 'other';
export interface WorkbenchStoragePart { kind: WorkbenchStorageCategory; bytes: number; files: number }
export interface WorkbenchStorageSummary {
  schema_version: 't1-storage-summary-1'; observed_at: string; scope: 'managed_workbench_files';
  total_bytes: number; protected_bytes: number; reclaimable_bytes: number; unknown_bytes: number; file_count: number;
  categories: WorkbenchStoragePart[];
  protected_reasons: Array<{ code: 'referenced' | 'recent_upload' | 'active_work' | 'immutable_source' | 'unsafe_link'; bytes: number; files: number }>;
  disk: { total_bytes: number; available_bytes: number } | null;
  cleanup_available: boolean;
  unavailable_reason?: 'storage_busy' | 'storage_scope_unavailable' | 'storage_reference_unavailable';
  policy: { automatic_cleanup: false; recent_upload_protection_hours: number };
}
export interface WorkbenchStorageCandidate {
  id: string; kind: 'unused_upload' | 'orphan_pdf' | 'orphan_parse' | 'orphan_figures' | 'orphan_export';
  name: string; bytes: number; files: number; paper_ids: string[]; last_uploaded_at?: string;
  detail: 'unused_upload_and_unreferenced_artifacts' | 'unreferenced_generated_files'; parts: WorkbenchStoragePart[];
}
export interface WorkbenchStoragePreview {
  schema_version: 't1-storage-preview-1'; summary: WorkbenchStorageSummary;
  preview_id: string; version: string; created_at: string; expires_at: string; candidates: WorkbenchStorageCandidate[];
}
export interface WorkbenchStorageCleanupInput { preview_id: string; version: string; candidate_ids: string[] }
export interface WorkbenchStorageCleanupResult {
  schema_version: 't1-storage-cleanup-1'; preview_id: string; status: 'complete' | 'partial'; already_executed: boolean;
  removed_bytes: number; removed_files: number; removed_paper_ids: string[];
  results: Array<{ id: string; status: 'removed' | 'already_missing' | 'failed' | 'protected'; removed_bytes: number; removed_files: number; error?: string }>;
  summary: WorkbenchStorageSummary;
}
export interface WorkbenchPaperDetail {
  paper: WorkbenchPaper; text_version: string; pdf_url: string; source_verified: boolean;
  figures: WorkbenchFigure[]; outputs: WorkbenchOutput[]; read_only: boolean;
  source_status?: 'valid' | 'missing' | 'mismatch' | 'not_parsed'; source_issues?: string[];
  source_units?: WorkbenchSourceUnit[];
}
/** Admission metadata is immutable per submission. Missing metadata means the legacy type was not recorded. */
export type WorkbenchSubmission = { kind: 'single' } | { kind: 'batch'; batch_id: string };
export interface WorkbenchRun {
  run_id: string; document_id: string; state: string; fixture: boolean; candidate_count: number;
  scope?: import('./index.js').Scope; scope_catalog?: import('./extraction-evidence.js').EvidenceCatalog;
  origin?: WorkbenchOutput['origin']; created_at?: string; error?: string;
  execution_started_at?: string; queue_wait_ms?: number; runtime_deadline?: string;
  result_ready?: boolean; finished_at?: string;
  /** Persisted task-scope completion only. Absent means completion is unknown. */
  task_processing_complete?: boolean;
  /** Versioned process result; a legacy projection never overwrites the persisted flag above. */
  task_completion?: WorkbenchTaskCompletion;
  submission?: WorkbenchSubmission;
  /** Independent submission name; batch members share the frozen group title. */
  task_title?: string;
  /** Original basename for this submission, never a path or bibliographic title. */
  original_filename?: string;
  provider?: string; model_id?: string;
  model_profile?: WorkbenchModelProfile;
  progress?: WorkbenchRunProgress;
}
/** Observed work only. Source-block completion is one stage, never a medical or full-task completion claim. */
export interface WorkbenchRunProgress {
  schema_version: 't1-workbench-progress-1';
  stage: 'queued' | 'parsing' | 'extracting' | 'reconciling' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'interrupted';
  updated_at?: string; stage_started_at?: string;
  elapsed_ms?: number; execution_elapsed_ms?: number; queue_wait_ms?: number;
  completed?: number; total?: number; unit?: 'source_blocks' | 'paragraphs' | 'content_units';
  /** Present only when the saved versioned plan recorded actual categories. */
  unit_counts?: Record<string, number>; completed_unit_counts?: Record<string, number>;
  completed_batches?: number; total_batches?: number; candidate_records: number;
  current_batch_id?: string; current_batch_index?: number; failed_batches?: number;
  /** Observed host lifecycle only; elapsed time is not completion or token progress. */
  operation?: { kind: 'model_request' | 'tool' | 'retry'; state: 'waiting_response' | 'receiving_response' | 'executing' | 'scheduled';
    started_at: string; elapsed_ms: number; attempt?: number; max_retries?: number; tool_name?: string };
  last_request?: { outcome: 'response_received' | 'failed'; finished_at: string; error_code?: string };
  /** Final, run-bound host reason only. Missing means the stopping cause is unknown. */
  termination_reason?: 'experiment_input_token_limit' | 'experiment_output_token_limit' | 'experiment_request_limit' |
    'experiment_time_limit' | 'document_time_limit' | 'request_time_limit' | 'pi_session_time_limit';
  source_gap_blocks?: number; summary_completed?: boolean;
  activity?: 'pdf_parse' | 'figure_discovery' | 'source_extraction' | 'whole_document_reconciliation';
  telemetry: 'events' | 'legacy_coverage' | 'unavailable';
}
/** Server-owned immutable configuration. No credentials, endpoints or per-run budgets. */
export interface WorkbenchModelProfile {
  profile_id: string; provider: string; model_id: string;
  api: 'openai-responses' | 'openai-completions'; reasoning_effort: 'medium' | 'none';
  context_window: number; max_output_tokens: number;
  configuration_source: 'server' | 'user';
}
export type WorkbenchModelProfileInput = Pick<WorkbenchModelProfile, 'model_id' | 'api' | 'reasoning_effort' | 'context_window' | 'max_output_tokens'>;
export interface WorkbenchModels {
  provider: string; default_profile_id: string | null; profiles: WorkbenchModelProfile[];
}
export interface WorkbenchCapabilities {
  schema_version: 't1-workbench-capabilities-1'; read_only: boolean; paper_upload: boolean;
  extraction_start: boolean; persisted_review: boolean; approved_export: boolean;
  persisted_retention?: boolean; retained_export?: boolean;
  backend_pi_sdk: '1.4.0';
  max_concurrent_runs?: number;
  model_runtime?: WorkbenchModelRuntime;
  model_selection?: boolean;
  extraction_unavailable_reason?: string; controlled_fixture?: boolean; max_pdf_bytes?: number;
}
export interface WorkbenchModelRuntime {
  provider: string; model_id: string; reasoning_effort: string;
  limits: { requests: number; input_tokens: number; output_tokens: number; execution_seconds: number };
}

export interface WorkbenchSourceUnit {
  unit_id: string; kind: string; source_type: string; completeness: string;
  boundary_reasons: string[]; segments: WorkbenchFragment[]; text: string;
  structure_unit_ids?: string[];
}
export interface WorkbenchLabels {
  feature_category?: string;
  evidence_type?: 'feature_mention' | 'definition' | 'imaging_observation' | 'interpretive_condition' | 'association_conclusion';
  tags?: string[]; comment?: string; evidence_role?: 'primary_candidate' | 'background_suggestion';
}
export interface WorkbenchRevisionInput {
  expected_version?: number; source_unit_ids?: string[]; context_unit_ids?: string[];
  labels?: WorkbenchLabels; reviewer: string; reason?: string;
}
export interface WorkbenchReviewInput {
  expected_version: number; action: 'approve_text' | 'approve_figures' | 'reject' | 'pending';
  reviewer: string; reason?: string; source_text_checked?: boolean; relevance_checked?: boolean;
  context_checked?: boolean; figure_pairing_checked?: boolean;
}
export interface WorkbenchEvent { run_id: string; seq: number; type: string; timestamp: string; detail: Record<string, unknown> }
export type WorkbenchExportKind = 'candidate_jsonl' | 'candidate_csv' | 'approved_jsonl' | 'approved_csv' | 'candidate_package' | 'approved_package' |
  'retained_jsonl' | 'retained_csv' | 'retained_package';
export interface WorkbenchRunDetail {
  run: WorkbenchRun; output: WorkbenchOutput; source_units: WorkbenchSourceUnit[]; source_issues: string[];
  source_status: string; paper: WorkbenchPaper; pdf_url: string; text_version: string; figures: WorkbenchFigure[];
  figure_catalog_sha256: string | null;
}
export interface WorkbenchFigureCheckInput {
  expected_catalog_sha256: string; reviewer: string; all_panels_included: boolean; caption_figure_identity_checked: boolean; notes: string;
}
export type WorkbenchScopeCatalog = import('./extraction-evidence.js').EvidenceCatalog & {
  default_scope: import('./index.js').Scope; restricted_available: boolean; restricted_reason: string | null; development_only: boolean;
};
export interface WorkbenchSameSourceReviewIndex {
  schema_version: string; raw_current_record_count: number; source_context_group_count: number; same_source_multi_member_group_count: number;
  groups: Array<{ group_id: string; member_count: number; evidence_field_differences: string[];
    members: Array<{ record_id: string; record_version: number; evidence_fields: Record<string, unknown> }>;
    same_literal_source_context_needs_review: boolean; internal_reference_role_needs_review: boolean;
    automatic_record_merge: boolean; approval_propagated: boolean }>;
  internal_reference_hints: Array<{ group_id: string; record_id: string; record_version: number; internal_structure_markers: string[] }>;
  read_only_derived_view: boolean; clinical_deduplication_claimed: boolean; medical_quality_approved: boolean;
}
