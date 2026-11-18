import { TASK_COMPLETION_RULE_VERSION, type WorkbenchRun } from "../../../packages/contracts/src/workbench";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Explain saved receipts only. Neither an explanation nor a summary receipt
 * supplies the persisted task completion flag. */
export function taskCompletionDetails(run: WorkbenchRun, coverage: unknown) {
  const saved = object(coverage);
  const summaryComplete = typeof saved.whole_document_summary_complete === "boolean" ? saved.whole_document_summary_complete
    : typeof run.progress?.summary_completed === "boolean" ? run.progress.summary_completed : undefined;
  const historicalProjection = run.task_completion?.rule_version === TASK_COMPLETION_RULE_VERSION && run.task_completion.rule_origin === "legacy_evidence_projection" && run.task_completion.processing_complete;
  const blockers = Array.isArray(saved.task_processing_blockers) ? saved.task_processing_blockers.filter((value): value is string => typeof value === "string" && !(historicalProjection && value === "source_glyph_quarantine_unresolved")) : [];
  if (run.error) blockers.push(run.error);
  const reasonKeys = [...new Set(blockers.map(code => {
    if (code === "source_glyph_quarantine_unresolved") return "completionLegacyInputBlocker";
    if (code === "selected_input_processing_incomplete") return "completionSourceBlocker";
    if (["summary_incomplete", "whole_document_summary_incomplete"].includes(code)) return "completionSummaryBlocker";
    if (["source_unsupported", "reliable_source_input_unavailable"].includes(code)) return "completionUnsupportedBlocker";
    if (["experiment_request_limit", "experiment_input_token_limit", "experiment_output_token_limit", "batch_response_limit"].includes(code)) return "completionBudgetBlocker";
    if (["experiment_time_limit", "document_time_limit"].includes(code)) return "completionTimeBlocker";
    if (["run_cancelled", "parser_aborted"].includes(code)) return "completionCancelledBlocker";
    if (code.startsWith("delivery_")) return "completionDeliveryBlocker";
    return "completionOtherBlocker";
  }))];
  return { summaryComplete, reasonKeys };
}
