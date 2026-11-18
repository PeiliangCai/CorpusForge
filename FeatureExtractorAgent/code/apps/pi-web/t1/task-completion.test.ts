import assert from "node:assert/strict";
import test from "node:test";
import { TASK_COMPLETION_RULE_VERSION, type WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { runPresentation } from "./run-presentation";
import { taskCompletionDetails } from "./task-completion";

const run = (state: string, props: Partial<WorkbenchRun> = {}) => ({ run_id: "current-run", state, candidate_count: 0, result_ready: true, ...props } as WorkbenchRun);

test("saved source gaps explain an ended task separately from successful automatic summary and retention", () => {
  const coverage = { task_processing_complete: false, whole_document_summary_complete: true, parser_status: "parsed",
    source_glyph_quarantined_block_ids: ["gap"], task_processing_blockers: ["source_glyph_quarantine_unresolved"] };
  const before = JSON.stringify(coverage), current = run("partial");
  assert.deepEqual(taskCompletionDetails(current, coverage), { summaryComplete: true, reasonKeys: ["completionLegacyInputBlocker"] });
  assert.equal(runPresentation(current.state, coverage).sourceLimited, false);
  assert.equal(runPresentation(current.state, coverage).statusKey, "taskEndedIncomplete");
  assert.equal(JSON.stringify(coverage), before);
});

test("only an explicit server-verified legacy projection can separate flow completion from its unchanged false", () => {
  const current = run("partial", { task_processing_complete: false, task_completion: {
    rule_version: TASK_COMPLETION_RULE_VERSION, rule_origin: "legacy_evidence_projection", processing_complete: true,
    source_gap_blocks: 1, original_task_processing_complete: false, original_rule_version: "legacy-task-completion-1",
  } });
  const coverage = { task_processing_complete: false, whole_document_summary_complete: true, task_processing_blockers: ["source_glyph_quarantine_unresolved"] };
  const shown = runPresentation(current.state, coverage, current.result_ready, current.task_completion);
  assert.equal(shown.statusKey, "completed"); assert.equal(shown.taskComplete, true); assert.equal(shown.sourceLimited, false);
  assert.deepEqual(taskCompletionDetails(current, coverage), { summaryComplete: true, reasonKeys: [] });
  assert.equal(coverage.task_processing_complete, false); assert.equal(current.task_processing_complete, false);
  assert.equal(runPresentation(current.state, coverage).taskComplete, false, "summary and old false alone are insufficient");
  assert.equal(runPresentation(current.state, coverage, false, current.task_completion).taskComplete, false);
  assert.equal(runPresentation("cancelled", coverage, true, current.task_completion).taskComplete, false);
});

test("known false and missing receipts remain distinct and never use another task's completion", () => {
  const first = run("partial", { task_processing_complete: true }), second = run("partial", { task_processing_complete: false });
  assert.equal(runPresentation(first.state, first).statusKey, "completed");
  assert.equal(runPresentation(second.state, second).statusKey, "taskEndedIncomplete");
  assert.equal(runPresentation(second.state, { whole_document_summary_complete: true }).statusKey, "taskEndedUnknown");
  assert.deepEqual(taskCompletionDetails(second, undefined), { summaryComplete: undefined, reasonKeys: [] });
  assert.equal(runPresentation(first.state, first, false).statusKey, "taskFinalizing");
  assert.equal(runPresentation(first.state, { ...first, result_ready: false }).taskComplete, false);
});

test("budget, summary and save failures disclose actual causes without inventing a completion flag", () => {
  const current = run("partial", { error: "experiment_request_limit" });
  const details = taskCompletionDetails(current, { whole_document_summary_complete: false,
    task_processing_blockers: ["summary_incomplete", "whole_document_summary_incomplete", "delivery_validation_failed"] });
  assert.deepEqual(details, { summaryComplete: false, reasonKeys: ["completionSummaryBlocker", "completionDeliveryBlocker", "completionBudgetBlocker"] });
  assert.equal(runPresentation(current.state, {}).taskComplete, false);
  assert.deepEqual(taskCompletionDetails(run("cancelled", { error: "parser_aborted" }), undefined).reasonKeys, ["completionCancelledBlocker"]);
});
