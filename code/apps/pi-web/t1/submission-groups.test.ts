import test from "node:test";
import assert from "node:assert/strict";
import { TASK_COMPLETION_RULE_VERSION, type WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { groupSubmittedRuns, resultRecordKey, submissionRun } from "./submission-groups";
import { runPresentation } from "./run-presentation";

test("mixed historical lines and new paragraphs are never added into a fictitious unit count", () => {
  const base = { document_id: "p", state: "extracting", candidate_count: 0, fixture: true, submission: { kind: "batch", batch_id: "b" } } as const;
  const member = (run_id: string, unit: "paragraphs" | "source_blocks"): WorkbenchRun => ({ ...base, run_id, progress: { schema_version: "t1-workbench-progress-1", unit, stage: "extracting", completed: 1, total: 2, candidate_records: 0, telemetry: "events" } });
  const mixed = submissionRun(groupSubmittedRuns([member("a", "paragraphs"), member("b", "source_blocks")])[0]!);
  assert.equal(mixed.progress?.completed, undefined); assert.equal(mixed.progress?.total, undefined);
  const current = submissionRun(groupSubmittedRuns([member("a", "paragraphs"), member("b", "paragraphs")])[0]!);
  assert.equal(current.progress?.unit, "paragraphs"); assert.equal(current.progress?.completed, 2); assert.equal(current.progress?.total, 4);
});

test("only admitted metadata groups batches; repeated papers, singles and legacy runs remain exact", () => {
  const runs = [
    { run_id: "repeat-new", document_id: "p", submission: { kind: "single" }, created_at: "2026-11-04" },
    { run_id: "batch-a", document_id: "p", submission: { kind: "batch", batch_id: "b1" }, created_at: "2026-11-03" },
    { run_id: "batch-b", document_id: "q", submission: { kind: "batch", batch_id: "b1" }, created_at: "2026-11-02" },
    { run_id: "old-a", document_id: "p", created_at: "2026-11-01" },
    { run_id: "old-b", document_id: "p", created_at: "2026-11-01" },
  ] as WorkbenchRun[];
  const original = structuredClone(runs), groups = groupSubmittedRuns(runs);
  assert.deepEqual(groups.map(group => [group.id, group.kind, group.runs.map(run => run.run_id)]), [
    ["run:repeat-new", "single", ["repeat-new"]], ["batch:b1", "batch", ["batch-a", "batch-b"]], ["run:old-a", "unrecorded", ["old-a"]], ["run:old-b", "unrecorded", ["old-b"]],
  ]);
  assert.equal(groups.reduce((count, group) => count + group.runs.length, 0), runs.length);
  assert.deepEqual(runs, original);
  assert.equal(groupSubmittedRuns(runs.filter(run => run.run_id !== "batch-a")).find(group => group.id === "batch:b1")!.runs.length, 1);
  assert.deepEqual(groupSubmittedRuns([]), []);
});

test("completion stays true, false or unknown independently of selected run and summary receipts", () => {
  const base: WorkbenchRun = { run_id: "a", document_id: "same-paper", state: "partial", fixture: true, candidate_count: 1 };
  const runs = [base, { ...base, run_id: "b", task_processing_complete: false }, { ...base, run_id: "c", task_processing_complete: true }];
  for (const _selected of runs) assert.deepEqual(runs.map(run => runPresentation(run.state, run).statusKey), ["taskEndedUnknown", "taskEndedIncomplete", "completed"]);
  assert.equal(runPresentation("partial", { progress: { summary_completed: true } }).statusKey, "taskEndedUnknown");
});

test("a first member's legacy projection never replaces the whole batch's outcome", () => {
  const first: WorkbenchRun = { run_id: "a", document_id: "p", state: "partial", fixture: true, candidate_count: 0, result_ready: true,
    task_processing_complete: false, submission: { kind: "batch", batch_id: "b" }, task_completion: { rule_version: TASK_COMPLETION_RULE_VERSION,
      rule_origin: "legacy_evidence_projection", processing_complete: true, source_gap_blocks: 1, original_task_processing_complete: false } };
  const group = (complete: boolean) => groupSubmittedRuns([first, { ...first, run_id: "b", task_completion: { ...first.task_completion!, processing_complete: complete } }])[0]!;
  const incomplete = submissionRun(group(false));
  assert.equal(incomplete.task_completion, undefined); assert.equal(incomplete.task_processing_complete, false);
  assert.equal(runPresentation(incomplete.state, incomplete).taskComplete, false);
  const completed = submissionRun(group(true));
  assert.equal(runPresentation(completed.state, completed).statusKey, "completed");
  assert.equal(completed.progress?.source_gap_blocks, 2); assert.equal(first.task_processing_complete, false);
});

test("batch outcome considers every submitted member and composite record identity avoids cross-run collisions", () => {
  const base: WorkbenchRun = { run_id: "a", document_id: "p", state: "completed", fixture: true, candidate_count: 2, task_processing_complete: true, submission: { kind: "batch", batch_id: "b" } };
  const group = (other: Partial<WorkbenchRun>) => groupSubmittedRuns([base, { ...base, run_id: "b", document_id: "q", ...other }])[0]!;
  assert.equal(submissionRun(group({})).candidate_count, 4);
  assert.equal(runPresentation(submissionRun(group({})).state, submissionRun(group({}))).statusKey, "completed");
  assert.equal(runPresentation("partial", submissionRun(group({ task_processing_complete: undefined }))).statusKey, "taskEndedUnknown");
  assert.equal(runPresentation("partial", submissionRun(group({ task_processing_complete: false }))).statusKey, "taskEndedIncomplete");
  assert.equal(submissionRun(group({ state: "queued", task_processing_complete: undefined })).state, "queued");
  assert.equal(submissionRun(group({ state: "queued", task_processing_complete: undefined })).task_processing_complete, undefined);
  assert.equal(submissionRun(group({ result_ready: false })).state, "reconciling");
  assert.equal(runPresentation(submissionRun(group({ result_ready: false })).state, submissionRun(group({ result_ready: false }))).taskComplete, false);
  assert.notEqual(resultRecordKey({ run_id: "a", id: "same-record" }), resultRecordKey({ run_id: "b", id: "same-record" }));
});
