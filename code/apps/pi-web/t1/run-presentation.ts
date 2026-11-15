import { TASK_COMPLETION_RULE_VERSION, type WorkbenchTaskCompletion } from "../../../packages/contracts/src/workbench";

/** Display persisted task-scope completion separately from the unchanged legacy run state. */
export function runPresentation(state: string | undefined, coverage: unknown, resultReady?: boolean, taskCompletion?: WorkbenchTaskCompletion) {
  const value = coverage && typeof coverage === "object" && !Array.isArray(coverage) ? coverage as Record<string, unknown> : {};
  const completion = taskCompletion ?? value.task_completion as WorkbenchTaskCompletion | undefined;
  const versioned = completion?.rule_version === TASK_COMPLETION_RULE_VERSION && ["persisted", "legacy_evidence_projection"].includes(completion.rule_origin);
  const ended = ["completed", "partial", "failed", "cancelled", "interrupted"].includes(state ?? "");
  const unsuccessful = ["failed", "cancelled", "interrupted"].includes(state ?? "");
  const finalizing = ended && (resultReady ?? value.result_ready) === false;
  const taskComplete = ended && !unsuccessful && !finalizing && (versioned ? completion.processing_complete === true : value.task_processing_complete === true);
  const completionKnownFalse = versioned ? completion.processing_complete === false : value.task_processing_complete === false;
  const statusKey = finalizing ? "taskFinalizing" : taskComplete ? "completed"
    : state === "completed" || state === "partial" ? completionKnownFalse ? "taskEndedIncomplete" : "taskEndedUnknown"
    : state ?? "noSelectedTask";
  const hintKey = finalizing ? "taskFinalizingHint" : taskComplete ? "completedHint"
    : unsuccessful ? "cancelledHint"
    : ended ? completionKnownFalse ? "taskIncompleteHint" : "taskUnknownHint"
    : "runningHint";
  const hasItems = (items: unknown) => Array.isArray(items) && items.length > 0;
  const structure = value.parser_structure_limitations;
  const structureLimited = structure !== null && typeof structure === "object" && Object.values(structure).some(hasItems);
  const glyphDiagnostics = hasItems(value.source_glyph_quarantined_block_ids) || hasItems(value.source_glyph_issue_block_ids) || (versioned && completion.source_gap_blocks > 0);
  const sourceLimited = value.parser_status === "failed" || value.parser_status === "partial" && !glyphDiagnostics
    || value.source_text_layer_decode_complete === false || hasItems(value.parser_failed_pages)
    || hasItems(value.image_text_unverified_pages) || structureLimited;
  return { statusKey, hintKey, taskComplete, ended, finalizing, sourceLimited };
}
