import test from "node:test";
import assert from "node:assert/strict";
import { TASK_COMPLETION_RULE_VERSION, type WorkbenchRun } from "../../../packages/contracts/src/workbench";
import { batchProgress } from "./batch-progress";

const run = (state: string, completion?: boolean, ready = true): WorkbenchRun => ({ run_id: state, document_id: state, state, fixture: true, candidate_count: 0,
  result_ready: ready, ...(completion === undefined ? {} : { task_processing_complete: completion }), progress: { schema_version: "t1-workbench-progress-1", stage: "extracting", candidate_records: 0, telemetry: "events", completed: 100, total: 100, summary_completed: true } });

test("parallel stage counts cover every member, including finalization and unknown states", () => {
  const progress = batchProgress([run("queued", undefined, false), run("parsing", undefined, false), run("extracting", undefined, false), run("reconciling", undefined, false), run("partial", false), run("completed", true, false), run("future", undefined, false)]);
  assert.deepEqual(progress.stages.map(stage => stage.count), [1, 1, 1, 1, 1]);
  assert.equal(progress.finishing, 1); assert.equal(progress.unknownState, 1); assert.equal(progress.ended, 1); assert.equal(progress.percent, 14); assert.equal(progress.allComplete, false);
});

test("batch flow completion uses each member's verified result while preserving historical false and gap status", () => {
  const projected: WorkbenchRun = { ...run("partial", false), task_completion: { rule_version: TASK_COMPLETION_RULE_VERSION,
    rule_origin: "legacy_evidence_projection", processing_complete: true, source_gap_blocks: 1, original_task_processing_complete: false } };
  const all = batchProgress([projected, run("completed", true)]);
  assert.equal(all.allComplete, true); assert.equal(all.percent, 100); assert.equal(all.outcomes[0].status, "completedWithSourceGaps");
  assert.equal(batchProgress([projected, run("partial", false)]).allComplete, false);
  assert.equal(batchProgress([projected, run("partial")]).allComplete, false);
  assert.equal(projected.task_processing_complete, false);
});

test("100% ended includes failures/cancellation/unknown completion and never certifies task success", () => {
  const progress = batchProgress([run("completed", true), run("partial", undefined), run("partial", false), run("failed", true), run("cancelled", true), run("interrupted")]);
  assert.equal(progress.percent, 100); assert.equal(progress.allEnded, true); assert.equal(progress.allComplete, false); assert.equal(progress.candidates, 0);
  assert.deepEqual(progress.outcomes.map(item => item.status), ["completed", "taskEndedUnknown", "taskEndedIncomplete", "failed", "cancelled", "interrupted"]);
});

test("only all persisted successful completion is complete; extraction receipts and empty batches supply no success", () => {
  assert.equal(batchProgress([run("completed", true), run("partial", true)]).allComplete, true);
  assert.equal(batchProgress([run("extracting", undefined, false)]).percent, 0);
  assert.equal(batchProgress([run("completed", true, false)]).allComplete, false);
  assert.equal(batchProgress([]).percent, undefined); assert.equal(batchProgress([]).allComplete, false);
});
